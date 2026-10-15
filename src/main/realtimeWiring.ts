/**
 * Realtime Michael (voice): wires the realtime IPC, the voice action adapters, the
 * completion watcher and the floor-delta watcher to the hive.
 */
import { ipcMain, Notification } from 'electron';
import { RealtimeFloorWatcher } from './realtimeFloorWatcher';
import { readConfig, writeConfig, type HarnessConfig } from './config';
import type { HiveTask } from './hive';
import { registerRealtimeIpc } from './realtime';
import { registerRealtimeActionIpc } from './realtimeActions';
import { initCompletionWatcher, type TaskCard, type InboxMessage } from './realtimeCompletionWatcher';
import { resolveGodName } from '../shared/godIdentity';
import { spawnAgentCore, teardownPty } from './agentSpawn';
import type { AgentSpawnOptions } from './agentSpawn';
import { control, hive, ptyManager } from './services';
import { liveWebContents } from './windows';

// ─── IPC: Realtime Michael voice ACTIONS (rt-5, Phase 2) ─────────────────────
// Thin adapters over the SAME main fns the god PTY already uses. ALL of the safety
// spine — soft-vs-destructive tiering, the two-step verbal echo-back confirm, the
// distinct-token rule, the hard allowlist (kill-god / mass-ops forbidden), and the
// michael-voice attribution — lives in ./realtimeActions. This site only injects
// the existing functions; it adds NO new orchestration logic.
// ─── IPC: Realtime Michael completion watcher (rt-12, Phase 2) ───────────────
// Jim's net-new engine (realtimeCompletionWatcher.ts) detects a voice-dispatched
// task finishing (card→done OR a done-reply in michael-voice's inbox) and EMITS it;
// I own the seam — inject the hive read deps, push completions to the live session
// (so Michael speaks them unprompted), and bridge waitFor / queue-drain over IPC.
const completionWatcher = initCompletionWatcher({
  readTasks: () => { const t = hive.tasks() as { tasks?: TaskCard[] }; return Array.isArray(t?.tasks) ? t.tasks : []; },
  // Voice dispatches go out as from:michael-voice, so assignee done-replies land here.
  readInbox: () => {
    // Voice dispatches go out from:michael-voice, so done-replies normally land in its
    // inbox — but an assignee may address god out of habit. Merge both inboxes (de-dupe
    // by id) so a god-addressed completion isn't missed; the detector filters by sender.
    try {
      const mv = hive.inbox('michael-voice') as unknown as InboxMessage[];
      const godId = hive.registry().godId;
      const god = godId ? (hive.inbox(godId) as unknown as InboxMessage[]) : [];
      const seen = new Set<string>();
      return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== undefined);
    } catch {
      return [];
    }
  },
  onNotify: (evt) => {
    try {
      if (!Notification.isSupported()) return;
      const reg = hive.registry();
      const title = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
      new Notification({ title, body: evt.summary }).show();
    } catch { /* best-effort */ }
  }
});
// v0.3.4: the floor delta watcher shares the session-live flag — while a voice
// session is open it pushes coalesced floor updates the renderer injects as
// silent conversation items (snapshot-at-connect + append-only deltas).
const floorWatcher = new RealtimeFloorWatcher({
  enabled: () => hive.enabled(),
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  ptys: () => ptyManager.list().map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
  push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch { /* window gone */ } }
});

/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerRealtimeWiring(): void {
  // ─── IPC: Realtime Michael (voice orchestrator — ephemeral token mint, rt-1) ──
  // MAIN owns the BYOK OpenAI key (encrypted broker, apikey:openai) and mints a
  // short-lived EPHEMERAL client secret; the real key never crosses IPC. All wiring
  // lives in ./realtime so this stays a single registration line.
  registerRealtimeIpc();

  registerRealtimeActionIpc({
    hiveEnabled: () => hive.enabled(),
    hiveSend: (partial, from) => hive.send(partial, from),
    hiveTasks: () => hive.tasks(),
    hiveAddTask: (task) => hive.addTask(task as HiveTask),
    hivePatchTask: (id, patch) => hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>),
    hiveDeleteTask: (id) => hive.deleteTask(id),
    hiveRegistry: () => hive.registry(),
    hiveLog: (event) => hive.appendLog(event),
    controlPause: (id, on) => control.pause(id, on),
    controlSteer: (id, text) => control.steer(id, text),
    controlHalt: (id) => control.halt(id),
    controlSnapshot: (id) => control.snapshot(id),
    killAgent: (id) => {
      const r = ptyManager.kill(id);
      teardownPty(id);
      // A voice (MAIN-initiated) kill: the renderer never removed the card itself
      // (unlike a UI kill), so tell the floor to archive it. Mirrors hive:agentSpawned.
      try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
      return r;
    },
    spawnAgent: async (opts) => {
      const o = opts as AgentSpawnOptions;
      const res = await spawnAgentCore(o, null);
      // The renderer roster is only mutated by renderer-initiated hires (AddAgentModal),
      // so a MAIN-initiated spawn is invisible on the floor until we broadcast it. The
      // renderer (useHive) builds the Agent card from this descriptor; addAgent is
      // idempotent so a renderer-initiated hire is never double-carded.
      if (res.ok) {
        try {
          liveWebContents()?.send('hive:agentSpawned', {
            id: o.id,
            name: o.hive?.name ?? o.id,
            provider: o.provider ?? o.hive?.provider ?? 'claude',
            cwd: res.worktreePath ?? o.cwd,
            command: o.command,
            role: o.hive?.role,
            worktreePath: res.worktreePath
          });
        } catch { /* window torn down */ }
      }
      return res;
    },
    listMissions: () => readConfig().missions ?? [],
    // The spec carries lastFiredAt through from listMissions(), so a wholesale write
    // preserves the scheduler's stamps; edit_schedule is deliberate + rare.
    saveMissions: (missions) => { writeConfig({ missions }); },
    // rt-12: register each voice dispatch so the watcher can detect its completion.
    trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch { /* watcher unavailable */ } },
    // ── v0.3.4 full-control extensions ──
    controlResume: (id) => control.resume(id),
    controlAutoDelivery: (id, paused) => control.pauseAutoDelivery(id, paused),
    controlGateTool: (id, toolName, on) => control.gateTool(id, toolName, on),
    setArchived: (id, archived) => {
      if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
      hive.setArchived(id, archived);
      try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', { id }); } catch { /* window gone */ }
      return { ok: true };
    },
    // clear_context: hand the text to the renderer's queue so delivery rides every
    // existing gate (idle-only, boot grace, draft/picker safety).
    enqueueToAgent: (id, text) => {
      try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch { /* window gone */ }
    },
    getConfigValue: (key) => (readConfig() as unknown as Record<string, unknown>)[key],
    patchConfig: (patch) => { writeConfig(patch as Partial<HarnessConfig>); }
  });

  // rt-12 seam: push detected completions to the live floor; bridge live-flag, queue
  // drain (closed-session warm-start), and wait_for over IPC. Then start polling.
  completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch { /* window gone */ } });
  floorWatcher.start();
  ipcMain.handle('realtime:setSessionLive', (_e, live: unknown) => {
    completionWatcher.setSessionLive(live === true);
    floorWatcher.setSessionLive(live === true);
    return { ok: true };
  });
  ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
  ipcMain.handle('realtime:waitFor', (_e, taskId: unknown, timeoutMs: unknown) =>
    typeof taskId === 'string'
      ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000)
      : Promise.resolve({ timedOut: true as const, taskId: '' }));
  completionWatcher.start();
}
