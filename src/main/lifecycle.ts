/**
 * App lifecycle: bootstrapping hive services, quit / closing time / reset / change-home
 * teardown. Every path that moves or wipes the hive flushes hive commits first.
 */
import { app, ipcMain } from 'electron';
import { rmSync, existsSync, cpSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { abortPendingRestart } from './updater';
import { readConfig, writeConfig, resetConfig, ensureHarnessHome } from './config';
import { expandTilde } from './fs';
import { ClosingTimeController } from './closingTime';
import { setAllowQuit } from './quitState';
import { ptyToAgent } from './agentSpawn';
import { archiveOrphanedAgents, armAlwaysOnBeats } from './heartbeat';
import { clearContextTimers, clearMissionTimers, ensureDefaultMissions, syncContextTriggers, syncMissions } from './schedules';
import { control, hive, hookServer, integrationBroker, memory, persist, ptyManager, reflector, roster, telemetry } from './services';
import { startSlackServer, stopSlackServer } from './slackService';
import { reconcileWebhookServer, startWebhookDoneObserver, stopWebhookDoneObserver, stopWebhookServer } from './webhookService';
import { liveWebContents } from './windows';
import { startEphemeralWorkerWatcher, stopEphemeralWorkerWatcher } from './workers';

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
/** Tear the harness down and quit. Shared by the hard "kill all & quit" path
 *  and the closing-time conclusion (after the god confirmed the floor saved). */
export function teardownAndQuit(): void {
  setAllowQuit();
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[quit] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[quit] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[quit] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[quit] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { hive.stopAllProxyBridges(); } catch (e) { console.error('[quit] stopAllProxyBridges:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  // Last: anything the steps above queued (an archive on teardown, a routed
  // message) is committed before the process goes away.
  try { hive.flushCommitsSync(); } catch (e) { console.error('[quit] flushCommits:', e); }
  app.quit();
}

// ─── IPC: closing time (graceful, data-loss-free shutdown) ──────────────────
// The third quit-dialog button. The god broadcasts closing time, every worker
// saves its memory and ACKs, the god concludes with CLOSING-TIME-COMPLETE —
// only then does the harness tear down. See closingTime.ts for the protocol.
const closingTime = new ClosingTimeController(
  hive,
  // Roster source: agents with a live PTY right now (ptyToAgent is pruned on
  // every teardown). The registry alone would include ghost workers from
  // sessions that ended with a hard quit — never archived, never able to ACK.
  () => [...new Set(ptyToAgent.values())],
  () => liveWebContents(),
  () => teardownAndQuit(),
  // #7C.2 steering — the graceful interrupt that reaches deeply busy agents
  // at their next hook boundary instead of waiting for a Stop.
  control
);

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
export function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  hive.refreshGeneratedDocs();
  // Tell the hive what it is running inside, BEFORE anything spawns: the prompt
  // builder reads this, so an agent spawned earlier would never learn it.
  hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() });
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  // An app-start marker in the event log. log.jsonl had twelve event kinds and
  // none of them meant "the app restarted", so a relaunch, and more importantly a
  // switch between a packaged build and a local one, was invisible to every agent
  // reading the feed. That gap cost a multi-hour investigation whose answer was
  // exactly this: a local build inherits the launching shell's umask, a
  // Finder-launched app does not.
  hive.appendLog({
    kind: 'app-start',
    version: app.getVersion(),
    packaged: app.isPackaged,
    // WHICH bundle, not just which version. Version plus packaged is not enough
    // to tell two builds apart: a stale copy in /Applications and a fresh one in
    // dist/ can report the same version and both be packaged, and picking the
    // wrong one by habit looks exactly like the new build being broken. Cost us
    // twice before this line existed.
    appPath: app.getAppPath(),
    exePath: process.execPath,
    electron: process.versions.electron,
    platform: process.platform
  });
  control.replaceAutoDeliveryPauses(readConfig().autoDeliveryPausedAgents ?? []);
  archiveOrphanedAgents(); // #57/#58: archive stale archived:false entries with no live PTY
  hive.startRouter();
  startEphemeralWorkerWatcher(); // poll HIVE_ROOT/spawn-requests → ephemeral workers
  // Phase 2: the loopback secret broker. Bind it BEFORE workers spawn so each spawn can
  // be granted a capability token + the broker URL in its env. Loopback-only, idempotent.
  void integrationBroker.start().then((r) => {
    if (r.ok) console.log('[broker] integration broker listening on', integrationBroker.url());
    else console.error('[broker] failed to start:', r.error);
  });
  ensureDefaultMissions(); // one-time: seed the built-in hourly ops standup
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  syncContextTriggers(); // …and the context trigger's own compact/clear cadences
  // Pair replies to inbound webhook messages in the ledger. Tied to the FEATURE
  // (any endpoint configured), not to the server: an approved message's card can
  // finish long after the operator switched the public surface back off, and its
  // reply still belongs in the history.
  if ((readConfig().webhookTriggers ?? []).length > 0) startWebhookDoneObserver();
  hookServer.start();
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  memory.start(); // init shared palace + mine loop (no-op without mempalace)
  reflector.start(); // bound oversized memory.md files on a timer (no-op until threshold)

  armAlwaysOnBeats();
}

/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerLifecycleIpc(): void {
  // Change the harnessHome folder. Because every derived path (hive root, palace,
  // sock, agent dirs) resolves lazily through getHome(), the only real work is
  // optionally MOVING the existing hive + palace and relaunching so every service
  // re-binds against the new root. mode: 'move' copies the data (old kept as a
  // safety net), 'fresh' just re-points and bootstraps an empty home.
  ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
    if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
    const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
    // expandTilde BEFORE resolve: both UI callers feed a folder-dialog result
    // (always absolute), but the hive picker's recents list can serve a literal
    // "~/…" persisted by a pre-#140 build — resolve() would anchor that at cwd
    // and the app would relaunch against a real directory named "~". Same
    // defence-in-depth-at-the-consumer rule as expandTilde's own doc.
    const newHome = resolve(expandTilde(p.newHome));
    const oldRaw = readConfig().harnessHome;
    const oldHome = oldRaw ? resolve(oldRaw) : null;

    // Guard against same-folder / nested-folder (a move would self-copy forever).
    if (oldHome) {
      if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
      const a = newHome + sep, b = oldHome + sep;
      if (a.startsWith(b) || b.startsWith(a)) {
        return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
      }
    }

    const ensured = ensureHarnessHome(newHome);
    if (!ensured.ok) return ensured;

    // Tear down everything bound to the OLD root before copying, so nothing writes
    // mid-copy — a live git commit into hive/.git would otherwise be copied as a
    // half-written object and corrupt the moved repo.
    try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
    try { clearContextTimers(); } catch (e) { console.error('[changeHome] clearContextTimers:', e); }
    try { stopWebhookDoneObserver(); } catch (e) { console.error('[changeHome] stopWebhookDoneObserver:', e); }
    try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[changeHome] stopWorkerWatcher:', e); }
    try { integrationBroker.stop(); } catch (e) { console.error('[changeHome] broker.stop:', e); }
    try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
    try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
    try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
    try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
    try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
    try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }
    // Hive commits run in the background; wait for the one in flight and commit
    // the rest NOW, or cpSync below can copy a half-written .git object.
    try { hive.flushCommitsSync(); } catch (e) { console.error('[changeHome] flushCommits:', e); }

    if (mode === 'move' && oldHome) {
      try {
        // roster.json + its backups ride along with hive/palace: the roster is the
        // renderer's half of the same state, and leaving it behind would move the
        // agents' sessions and memory to the new home while their names, notes and
        // worktree paths stayed at the old one.
        for (const sub of ['hive', 'palace', 'roster.json', 'roster-backups']) {
          const src = join(oldHome, sub);
          if (!existsSync(src)) continue;
          // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
          // renameSync, which throws EXDEV across volumes). We COPY, never delete —
          // the old folder stays as a safety net the user removes manually.
          cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
        }
      } catch (e) {
        // Copy failed: recover IN PLACE against the unchanged old home (config never
        // repointed) so the user loses nothing, and surface the error — no relaunch.
        bootstrapHiveServices();
        const cfg = readConfig();
        if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
        reconcileWebhookServer();
        return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // Repoint config and relaunch so every service re-bootstraps against newHome.
    // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
    setAllowQuit();
    writeConfig({ harnessHome: newHome });
    try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
    app.relaunch();
    app.exit(0);
    return { ok: true as const }; // unreachable (process exits) — typed for the renderer
  });
  ipcMain.handle('app:confirmClose', () => {
    closingTime.cancel(); // a hard quit overrides a closing time in progress
    teardownAndQuit();
  });
  ipcMain.handle('app:cancelClose', () => {
    // The modal closes on the renderer side. The one thing main owes anybody here
    // is the truth about a restart-to-install: if this quit was one, it has just
    // been called off, and whoever is waiting on it needs to hear that rather than
    // sit disabled forever waiting for a process that is not going to die.
    abortPendingRestart();
  });
  hive.setRoutedObserver((msg, targets) => closingTime.onRouted(msg, targets));
  ipcMain.handle('app:startClosingTime', () => closingTime.start());
  ipcMain.handle('app:cancelClosingTime', () => closingTime.cancel());

  // ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
  ipcMain.handle('app:resetAll', () => {
    setAllowQuit();
    // Tear everything down first so nothing writes back into the dirs we wipe.
    try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
    try { clearContextTimers(); } catch (e) { console.error('[reset] clearContextTimers:', e); }
    try { stopWebhookDoneObserver(); } catch (e) { console.error('[reset] stopWebhookDoneObserver:', e); }
    try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[reset] stopWorkerWatcher:', e); }
    try { integrationBroker.stop(); } catch (e) { console.error('[reset] broker.stop:', e); }
    try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
    try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
    try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
    try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
    try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
    try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
    try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
    try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
    try { hive.removeExposedCodexData(); } catch (e) { console.error('[reset] removeExposedCodexData:', e); }
    // A background git process still writing .git/objects makes rmSync throw ENOTEMPTY.
    try { hive.flushCommitsSync(); } catch (e) { console.error('[reset] flushCommits:', e); }
    // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
    // git history) and the semantic-memory palace. Only these harness-created
    // subdirs are removed — never the user's whole harnessHome folder.
    for (const dir of [hive.root(), memory.palacePath()]) {
      if (!dir) continue;
      try { rmSync(dir, { recursive: true, force: true }); }
      catch (e) { console.error('[reset] rm', dir, e); }
    }
    // The roster is the renderer's half of the same state, so it retires with the
    // hive — archived into roster-backups/ rather than deleted, and cleared as the
    // active file so re-selecting this folder later doesn't resurrect agents whose
    // sessions and memory are gone.
    try { roster.archive(); }
    catch (e) { console.error('[reset] roster.archive:', e); }
    // Back to first-run defaults, then relaunch clean so all in-memory services
    // re-bootstrap from scratch and the renderer lands on onboarding.
    resetConfig();
    app.relaunch();
    app.exit(0);
  });
}
