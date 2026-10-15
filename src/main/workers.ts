/**
 * God-triggered ephemeral workers: the spawn-request watcher under
 * <hive>/spawn-requests, worker lifecycle and token caps, preserved worktrees and their
 * GC, and the workers:* IPC surface.
 */
import { ipcMain } from './ipc/typedIpc';
import { rmSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { isSafeCommandName } from './shellEnv';
import { readConfig } from './config';
import { expandTilde } from './fs';
import { getBranch, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe } from './git';
import { unlinkWorktreeDeps } from './worktreeDeps';
import type { AgentMeta } from './hive';
import * as integrations from './integrations';
import { buildWorkerLaunch } from './workerLaunch';
import type { AgentProvider } from '../shared/agentProvider';
import { spawnAgentCore, teardownPty } from './agentSpawn';
import type { AgentSpawnOptions } from './agentSpawn';
import { hive, integrationBroker, ptyManager, usageProvider } from './services';
import { buildAutonomousRequestProtocol, slackReplyScriptPath } from './slackService';
import { liveWebContents } from './windows';

/** A live god-triggered ephemeral worker, tracked from spawn to teardown. */
interface WorkerRec {
  workerId: string;       // == the PTY id == hive agent id (`worker-<reqId>`)
  reqId: string;          // the spawn-request id
  name?: string;          // display name (for the worker tab)
  slack?: { channel: string; thread_ts: string };
  baseBranch: string;     // the branch its worktree was cut from (for ahead-of-base)
  spawnedAt: number;      // epoch ms
  releasing?: boolean;    // kill issued; awaiting teardownPty (skip re-processing)
  /** Per-worker TOTAL-token cap from the spawn-request (overrides the config
   *  default). 0/undefined = no per-request cap. P4 plumbing — unlimited today. */
  tokenCap?: number;
}
/** Live ephemeral workers by id. Populated by the spawn-request watcher; consulted
 *  by teardownPty so a finished/crashed/reaped worker's worktree is PRESERVED (not
 *  force-removed) when it holds unintegrated work — god is the sole integrator. */
export const liveWorkers = new Map<string, WorkerRec>();

/** A worker worktree that teardown PRESERVED because it held unintegrated work.
 *  Tracked so the GC sweep can reclaim it (+ its scratch dir) once the work lands
 *  in base or the worktree is removed by hand — see gcPreservedWorktrees(). */
interface PreservedWorktree {
  workerId: string;
  wtPath: string;
  origCwd: string;        // the parent repo to run `git worktree remove` from
  baseBranch: string;     // re-checked against this for "integrated yet?"
  scratchDir: string | null; // HIVE_ROOT/agents/<workerId> — removed alongside the worktree
  slack?: { channel: string; thread_ts: string };
  preservedAt: number;    // epoch ms
}
/** Preserved worker worktrees awaiting integration, keyed by worktree path. The GC
 *  sweep drains this: an entry is removed (worktree + scratch GC'd) only when the
 *  work is provably integrated, or when the worktree is already gone from disk. */
const preservedWorktrees = new Map<string, PreservedWorktree>();

/** Send an inform to the god agent (the human's proxy). The ephemeral-worker
 *  controller uses this to surface every terminal failure AND to carry the Slack
 *  {channel,thread_ts} so god can post a 'couldn't complete' reply — closing the
 *  Slack loop (the success path is the worker replying in-thread itself). */
function informGod(subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  try {
    const slackLine = slack
      // The bundled-node launcher, spelled as an ABSOLUTE PATH — NOT bare `node`
      // (absent from the PATH of any machine whose node comes from nvm) and NOT
      // `$HIVE_NODE` (POSIX-only: cmd.exe/PowerShell expand it to nothing, so the
      // whole reply command was dead on Windows).
      ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${hive.nodeCommand()}" "${slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"`
      : '';
    hive.send({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

/** Gated worktree teardown for an ephemeral worker: remove it ONLY when it holds no
 *  unintegrated work; otherwise leave it (and its branch) in place and ping god, the
 *  sole integrator. Async + best-effort; on any uncertainty it KEEPS the worktree
 *  (fail-safe — never auto-discard possibly-valuable work). */
export async function finalizeWorkerWorktree(wtPath: string, origCwd: string, worker: WorkerRec): Promise<void> {
  try {
    const deps = await unlinkWorktreeDeps(origCwd, wtPath);
    if (!deps.ok) console.error('[worktree] dependency unlink failed:', deps.error);
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      // Track it so the GC sweep can reclaim it (+ scratch dir) once integrated —
      // the worker is gone from liveWorkers by now, so its identity lives here.
      preservedWorktrees.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
        scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
      });
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\n`
        + `Worktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\n`
        + `Review/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) { console.error('[worker] removeWorktree failed:', r.error); return; }
    // Worktree is gone (clean/integrated at teardown), but DEFER its scratch-dir
    // cleanup to the throttled GC sweep rather than deleting it synchronously here:
    // HIVE_ROOT/agents/<id> holds the worker's memory.md and the MemPalace miner
    // ingests it asynchronously, so an immediate delete can beat the miner and
    // permanently lose the worker's durable notes from the shared palace. Register
    // it (its worktree path is now absent) so the sweep's path-gone branch reclaims
    // the scratch after a window — same throttled path the preserved case uses.
    preservedWorktrees.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
      scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}

/** The hive scratch dir for a worker (its inbox/outbox/memory): HIVE_ROOT/agents/<id>.
 *  Null when there's no hive root. */
function workerScratchDir(workerId: string): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', workerId) : null;
}

/** Best-effort removal of a worker's scratch (hive agent) dir. Guarded to ONLY ever
 *  delete a path that resolves to exactly HIVE_ROOT/agents/<workerId> and never a
 *  still-live worker — so a crafted/mismatched id can't escape the agents root. */
function removeWorkerScratch(workerId: string): void {
  if (liveWorkers.has(workerId)) return; // never wipe a live worker's mailbox
  const dir = workerScratchDir(workerId);
  const root = hive.root();
  if (!dir || !root) return;
  const agentsRoot = join(root, 'agents');
  // Path-safety: the resolved dir must sit directly under agents/ with basename == id.
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir)) || basename(dir) !== workerId) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[worker] removeWorkerScratch failed:', e); }
}

// ─── god-triggered ephemeral Slack workers ──────────────────────────────────
// god drops a spawn-request JSON into HIVE_ROOT/spawn-requests/; MAIN polls that
// queue (same cadence + atomic-rename archival as the hive router — reliability
// over latency, no fs.watch/dedup needed), spins up a FRESH ISOLATED worker via
// the shared spawnAgentCore, dispatches the objective through the standard inbox
// path, then watches each worker for a terminal `act:"done"` (success → release)
// or excessive idleness (reap). All teardown flows through teardownPty's
// safety-gate, so a worker's worktree is never auto-removed while it holds
// unintegrated work. Every terminal failure informs god WITH the Slack coords so
// god closes the Slack loop; the success path is the worker replying in-thread.

/** A spawn-request god drops into HIVE_ROOT/spawn-requests/<id>.json. god authors
 *  these directly; `objective` and `cwd` are the only required fields. */
interface SpawnRequest {
  id?: string;
  objective?: string;
  command?: string;                                   // engine CLI; default = config.defaultCommand
  provider?: AgentProvider;                           // optional explicit provider
  model?: string;                                     // optional --model override (Claude)
  cwd?: string;                                        // repo the worker (and its worktree) runs in
  name?: string;                                       // display name
  slack?: { channel: string; thread_ts: string };     // reply target + where failures surface
  isolate?: boolean;                                   // default true (fresh worktree)
  tokenCap?: number;                                   // optional per-worker token cap (advisory P1)
  // Appearance on the office floor. Both optional and both validated renderer-side
  // against the real cast and accent lists, so a bad value degrades to the default
  // rather than breaking the card.
  //
  // Naming a worker after a cast member ALREADY gets you their avatar: the floor
  // card infers it from the name. These two exist for the case that inference
  // cannot express, an agent called something else that should still look like a
  // particular character, and picking the accent instead of taking the one hashed
  // from the worker id.
  character?: string;
  accent?: string;
}

/** Polling cadence — matches the hive router. */
const WORKER_TICK_MS = 1500;
let workerWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow tick (await spawn / git checks) never overlaps. */
let workerTickRunning = false;

/** HIVE_ROOT/spawn-requests — the queue dir god drops requests into. */
function spawnRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'spawn-requests') : null;
}

/** Move a processed request out of the queue so it's never reprocessed. */
function archiveRequest(filePath: string, sub: '.done' | '.failed'): void {
  const queue = spawnRequestsDir();
  try {
    if (!queue) throw new Error('no hive root');
    const dir = join(queue, sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // Last resort: delete it so a poison file can't loop forever.
    try { unlinkSync(filePath); } catch { /* noop */ }
    console.error('[worker] archiveRequest failed:', e);
  }
}

/** When did this worker post its terminal `act:"done"` — or null when it has
 *  not yet. Scans its own outbox AND outbox/.sent (the router archives delivered
 *  mail there ~every 1.5s), so the signal is caught whether or not it's been
 *  routed out yet. The timestamp (the newest done, if several) is the cut-off
 *  for settling its inbox: mail that arrived after it is still pending.
 *
 *  Stale-done guard: agent dirs persist after teardown, so REUSING a reqId would
 *  leave a PRIOR worker's `done` sitting in this same dir. Without a guard that
 *  stale signal would release the new worker on its very first tick — before it
 *  does anything or replies — causing a silent Slack hang. So we only count a
 *  `done` authored AFTER this worker spawned: by its `created_at` (the message's
 *  own timestamp), falling back to the file's mtime when `created_at` is missing
 *  or unparseable. When neither yields a usable timestamp we DON'T count it
 *  (fail toward keeping the worker alive — the idle reaper is the backstop). */
function workerDoneAt(workerId: string, spawnedAt: number): number | null {
  const root = hive.root();
  if (!root) return null;
  const base = join(root, 'agents', workerId, 'outbox');
  let doneAt: number | null = null;
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as { act?: string; created_at?: string };
        if (msg.act !== 'done') continue;
        let ts = Date.parse(msg.created_at ?? '');
        if (!Number.isFinite(ts)) {
          try { ts = statSync(fp).mtimeMs; } catch { ts = NaN; }
        }
        if (Number.isFinite(ts) && ts > spawnedAt && (doneAt === null || ts > doneAt)) doneAt = ts;
      } catch { /* skip unreadable/partial */ }
    }
  }
  return doneAt;
}

/** Spin up one ephemeral worker from a spawn-request. Terminal failures (bad
 *  request, missing CLI, spawn error) archive to .failed and inform god WITH the
 *  Slack coords so god can post a 'couldn't start' reply. On success the worker is
 *  registered (for done-scan / reaping / safe teardown) and dispatched its
 *  objective via the standard inbox path. */
async function processSpawnRequest(filePath: string): Promise<void> {
  let raw: SpawnRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest;
  } catch (e) {
    console.error('[worker] unparseable spawn-request:', filePath, e);
    informGod('[worker spawn rejected] unparseable request', `Could not parse spawn-request ${basename(filePath)} — ${String(e)}`);
    archiveRequest(filePath, '.failed');
    return;
  }
  const slack = raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
    ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
  const fail = (reason: string): void => {
    informGod(`[worker spawn rejected] ${reason}`, `Spawn-request ${basename(filePath)} rejected: ${reason}.`, slack);
    archiveRequest(filePath, '.failed');
  };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (!objective) { fail('missing "objective"'); return; }

  const reqId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(filePath).replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const workerId = `worker-${reqId}`;
  if (liveWorkers.has(workerId)) { fail(`worker "${workerId}" already running`); return; }

  // Worker request files are hand/LLM-authored, so `~/…` shows up here too — expand
  // before the existence check (Node reads `~` literally).
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? expandTilde(raw.cwd) : '';
  if (!cwd || !existsSync(cwd)) { fail(`"cwd" missing or not found (${cwd || 'unset'})`); return; }

  // Request line → executable + argv (auto-mode inheritance, tokenization,
  // model-flag dedupe). Pure and unit-tested — see workerLaunch.ts for why this
  // translation earned a test.
  const cfgSpawn = readConfig();
  const launch = buildWorkerLaunch({
    requestCommand: raw.command,
    requestProvider: raw.provider,
    requestModel: raw.model,
    defaultCommand: cfgSpawn.defaultCommand,
    autoMode: !!cfgSpawn.autoMode
  });
  const bin = launch.bin;
  // Validate the executable name on the spawn path. A spawn-request file is
  // untrusted input (authored by the orchestrator, reachable by anything that can
  // write HIVE_ROOT/spawn-requests), so the bin must be a plain command token or
  // an absolute path — never a string a downstream shell `which`/`where` could
  // reinterpret. Rejected here, before any resolution; the resolver guards behind
  // it validate the same thing in depth.
  if (!isSafeCommandName(bin) && !isAbsolute(bin)) {
    fail(`refusing spawn: engine command "${bin}" is not a plain command name or an absolute path`);
    return;
  }
  // Missing-CLI → FAIL FAST. A headless worker has no human to watch an installer,
  // so we never run the cc49e1e install banner here — we reject and tell god.
  if (!ptyManager.isCommandAvailable(bin)) { fail(`engine CLI "${bin}" is not installed`); return; }

  const isolate = raw.isolate !== false; // default true
  // Base branch the worktree will be cut from (for the ahead-of-base safety check).
  let baseBranch = 'main';
  try { const br = await getBranch(cwd); if ('current' in br && br.current) baseBranch = br.current; } catch { /* keep default */ }

  const meta: AgentMeta = {
    id: workerId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Worker ${reqId.slice(0, 12)}`,
    provider: raw.provider,
    role: 'worker',
    cwd
  };
  // Phase 2: grant this worker a broker capability over the currently-enabled
  // integrations and inject the broker URL + a per-worker capability TOKEN (a handle,
  // never a secret) into its env, so it can reach registered REST integrations through
  // the loopback secret broker without ever seeing a credential. Only when the broker
  // is up; the grant is revoked in teardownPty (and below if the spawn fails).
  const brokerEnv: Record<string, string> = {};
  if (integrationBroker.running()) {
    const token = integrationBroker.grant(workerId, integrations.enabledIds());
    brokerEnv.MD_BROKER_URL = integrationBroker.url();
    brokerEnv.MD_BROKER_TOKEN = token;
  }
  const spawnOpts: AgentSpawnOptions = {
    id: workerId, cwd, command: bin, cols: 120, rows: 32,
    args: launch.args,
    hive: meta, isolate, provider: raw.provider, env: brokerEnv
  };

  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await spawnAgentCore(spawnOpts, liveWebContents());
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) { integrationBroker.revoke(workerId); fail(`spawn failed — ${res.error ?? 'unknown error'}`); return; }

  // A god-hired worker is a MAIN-initiated spawn, so the renderer would never
  // card it on its own (same reason as the voice-spawn broadcast): without this
  // the worker is invisible on the floor, never enters the roster, and after a
  // restart nothing offers to restore it. The card rides the normal agent
  // lifecycle from here — teardownPty broadcasts the matching archive. A card
  // RESTORED after an app quit revives through the renderer's normal spawn path
  // and never re-enters liveWorkers: ephemerality is a property of the hiring,
  // not of the card, so a restored worker is a regular agent (no reaping).
  try {
    liveWebContents()?.send('hive:agentSpawned', {
      id: workerId,
      name: meta.name,
      provider: raw.provider ?? 'claude',
      cwd: res.worktreePath ?? cwd,
      command: launch.command,
      role: meta.role,
      worktreePath: res.worktreePath,
      character: typeof raw.character === 'string' ? raw.character : undefined,
      accent: typeof raw.accent === 'string' ? raw.accent : undefined
    });
  } catch { /* window torn down */ }

  // Register for done-scan / idle-reap / token-cap / safe teardown (pty id == workerId).
  // tokenCap is optional plumbing (default unlimited) — only a positive finite cap is kept.
  const tokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0
    ? raw.tokenCap : undefined;
  liveWorkers.set(workerId, { workerId, reqId, name: meta.name, slack, baseBranch, spawnedAt: Date.now(), tokenCap });

  // Dispatch the objective via the standard inbox path (zero new transport),
  // reusing the autonomous-request preamble so the worker gets the exact Slack
  // reply command + autonomy policy. `from: god` so the worker treats it as a god
  // dispatch per its protocol.
  try {
    const prefix = slack
      ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, slackReplyScriptPath())
      : '[AUTONOMOUS WORKER TASK — no interactive human is watching. Work autonomously; do not ask interactive questions.] The task starts now: ';
    const suffix = `\n\n[CAPABILITIES] Before you start, consult your capability catalog — run the \`/capabilities\` skill (or read \`$AGENT_DIR/.claude/skills/capabilities/SKILL.md\`). It lists your temporal date-range skills (\`/today\`, \`/last30Days\`, \`/lastQuarter\`, …) and the integrations available to you (reached via the loopback broker) and how to call each. For any time-scoped work, resolve the dates with those skills instead of computing them by hand.\n\n[WORKER COMPLETION] When finished, signal done by sending ONE outbox message to god with "act":"done" and a short result summary — that releases this ephemeral worker (terminal closed; your branch is handed to god). Do NOT push to any remote; god is the sole integrator.`;
    hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${prefix}${objective}${suffix}` }, 'god');
  } catch (e) {
    console.error('[worker] dispatch send failed:', e);
  }

  console.log(`[worker] spawned ${workerId} (cwd=${cwd}, base=${baseBranch}${slack ? ', slack' : ''})`);
  archiveRequest(filePath, '.done');
}

/** Total tokens (input+output+cache) a worker has burned so far, from the usage
 *  provider — 0 when unknown. Mirrors the breaker's `tokensOf`. Used only by the
 *  (default-off) per-worker token cap. */
function workerTokensUsed(workerId: string): number {
  const s = usageProvider.getAgentUsage(workerId);
  return s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;
}

/** Throttle for the GC sweep — git checks are cheap but pointless every 1.5s tick. */
const GC_SWEEP_MS = 60_000;
let lastGcSweepAt = 0;
let gcSweepRunning = false;

/** Reclaim preserved worker worktrees (+ their scratch dirs) whose work is now
 *  integrated, or whose worktree was already removed by hand. Fail-safe: a worktree
 *  is removed ONLY when `worktreeIsGcSafe` proves it clean AND integrated; any doubt
 *  KEEPS it (never discards un-integrated work — god is the sole integrator). Runs
 *  inside the worker tick, throttled to GC_SWEEP_MS, and is a no-op when nothing is
 *  preserved (the common case → zero cost). */
async function gcPreservedWorktrees(): Promise<void> {
  if (gcSweepRunning || preservedWorktrees.size === 0) return;
  gcSweepRunning = true;
  try {
    for (const [key, e] of [...preservedWorktrees]) {
      // A worker id that is live again (reqId reuse) → never GC its worktree or
      // scratch out from under the new run; leave the stale entry for a later sweep.
      if (liveWorkers.has(e.workerId)) continue;
      // (a) Worktree already gone (removed at clean teardown, or god removed it by
      //     hand per the preserve note) → just reclaim the scratch dir + drop tracking.
      if (!existsSync(e.wtPath)) {
        removeWorkerScratch(e.workerId);
        preservedWorktrees.delete(key);
        console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
        continue;
      }
      // (b) Still on disk → reclaim ONLY when provably integrated + clean.
      const deps = await unlinkWorktreeDeps(e.origCwd, e.wtPath);
      if (!deps.ok) { console.error('[worker gc] dependency unlink failed (keeping):', deps.error); continue; }
      let safe: { gc: boolean; detail: string };
      try { safe = await worktreeIsGcSafe(e.wtPath, e.baseBranch); }
      catch (err) { console.error('[worker gc] gc-safe check threw (keeping):', err); continue; }
      if (!safe.gc) continue; // keep — fail-safe
      const r = await removeWorktree(e.origCwd, e.wtPath);
      if (!r.ok) { console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error); continue; }
      removeWorkerScratch(e.workerId);
      preservedWorktrees.delete(key);
      console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
      informGod(
        `[worker worktree reclaimed] ${e.workerId}`,
        `The preserved worktree for ${e.workerId} is now integrated (${safe.detail}), so it and its scratch dir were garbage-collected.\nWorktree: ${e.wtPath}`,
        e.slack
      );
    }
  } finally {
    gcSweepRunning = false;
  }
}

/** One controller tick: (1) finish/reap live workers (frees slots), then (2) pull
 *  new requests up to the concurrency cap. Order matters so a freed slot is reused
 *  the same tick. */
async function ephemeralWorkerTick(): Promise<void> {
  if (workerTickRunning) return;
  workerTickRunning = true;
  try {
    const cfg = readConfig();
    const maxWorkers = Math.max(1, cfg.maxConcurrentWorkers ?? 4);
    const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 60_000;
    // Per-worker token cap. 0 = UNLIMITED (the default — wired but never throttles
    // unless a positive cap is set per-request or via defaultWorkerTokenCap).
    const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;

    // (1) Finish or reap. Each release calls teardownPty EXPLICITLY after the
    //     kill, like every other kill site: ptyManager.kill() deletes the session
    //     synchronously, so when node-pty's async onExit later fires it fails the
    //     session-identity guard and the global exit handler (→ teardownPty)
    //     never runs. Relying on onExit here left released workers un-torn-down:
    //     no hive archive, no hive:agentArchived, frozen floor cards, and god
    //     kept mailing dead agents (seen live 2026-08-16 with worker-business/
    //     worker-qa/worker-bizreview). A double teardown is a harmless no-op.
    for (const [workerId, rec] of [...liveWorkers]) {
      if (rec.releasing) continue;
      const doneAt = workerDoneAt(workerId, rec.spawnedAt);
      if (doneAt !== null) {
        // Success: the worker already replied in-thread; just release it.
        rec.releasing = true;
        console.log(`[worker] ${workerId} signaled done — releasing`);
        // Its mailbox is finished with too. Workers seldom file their own work
        // order before signaling done, and the id is reused on every re-hire of
        // the same name, so anything left unread here would greet the next
        // incarnation as "pending" work (seen live 2026-09-07: 13 of 30 worker
        // inboxes carried finished orders; a re-hired worker spent its first
        // turns re-triaging yesterday's, and the watchdog read it as mail
        // unanswered for 21h). Only the DONE path settles — an idle/token-cap
        // reap never signaled completion, so its unread mail stays pending —
        // and only mail from BEFORE the done signal: a follow-up that crossed
        // the worker's done is still nobody's, so it stays pending. God hears
        // which requests/queries were filed unread, so none vanishes silently.
        const settled = hive.settleInbox(workerId, doneAt);
        if (settled.moved > 0) console.log(`[worker] ${workerId}: filed ${settled.moved} unread inbox message(s) under inbox/.done`);
        if (settled.kept > 0) console.log(`[worker] ${workerId}: left ${settled.kept} message(s) that arrived after its done signal pending`);
        // The worker's own work order is dispatched in conversation
        // `worker-<reqId>` (processSpawnRequest) and is exactly what it just
        // completed: reporting it "filed unread" on every release would cost
        // god a turn each time for nothing. Only OTHER requests/queries count.
        // Subjects are agent-written: keep each on its own line.
        const unanswered = settled.unanswered.filter((m) => m.conversation !== `worker-${rec.reqId}`);
        if (unanswered.length > 0) {
          const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');
          const lines = unanswered.map((m) => `- ${m.act} ${oneLine(m.id)} from ${oneLine(m.from)}: "${oneLine(m.subject)}"`);
          informGod(
            `[worker released — mail filed unread] ${workerId}`,
            `Worker ${workerId} signaled done and was released. These messages were still unread in its inbox and were filed under inbox/.done without an answer:\n`
            + lines.join('\n')
            + `\nIf one of them is not the order it just completed, nobody is working on it — resend it to another agent or re-hire the worker.`,
            rec.slack
          );
        }
        ptyManager.kill(workerId);
        teardownPty(workerId);
        continue;
      }
      // Token-cap reap (default-off plumbing). An effective cap > 0 → reap when the
      // worker's cumulative token use exceeds it; its committed work is preserved.
      const tokenCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : defaultTokenCap;
      if (tokenCap > 0) {
        const used = workerTokensUsed(workerId);
        if (used > tokenCap) {
          rec.releasing = true;
          console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
          informGod(
            `[worker reaped — token cap] ${workerId}`,
            `Worker ${workerId} used ${used.toLocaleString()} tokens (> its cap of ${tokenCap.toLocaleString()}) and was reaped. Any committed work on its branch is preserved for you.`,
            rec.slack
          );
          ptyManager.kill(workerId);
          teardownPty(workerId);
          continue;
        }
      }
      const idleMs = ptyManager.idleFor(workerId);
      if (idleMs === undefined) continue; // PTY already gone; teardownPty cleans up
      if (idleMs > idleTimeoutMs) {
        rec.releasing = true;
        console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 60000)}min idle)`);
        informGod(
          `[worker reaped — idle] ${workerId}`,
          `Worker ${workerId} produced no output for ${Math.round(idleMs / 60000)} min (> the ${Math.round(idleTimeoutMs / 60000)} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.`,
          rec.slack
        );
        ptyManager.kill(workerId);
        teardownPty(workerId);
      }
    }

    // (2) Process new requests, honoring the concurrency cap (backpressure: leave
    //     the rest in the queue for a later tick).
    //
    //     Gated on config.orchestratorMaySpawn (default OFF): letting the
    //     orchestrator spin up agents unprompted is a SPEND decision, so the
    //     operator opts in. The gate sits HERE, on intake, and not on the watcher
    //     itself, because step (1) above owns the lifecycle of workers that are
    //     already running — reaping, teardown, the Slack failure notice — and
    //     turning the toggle off mid-flight must not strand them.
    //
    //     Declining also means declining to CONSUME. A request dropped in while
    //     this is off stays in the queue and runs when it is turned on, rather
    //     than being eaten and failed for a reason god never asked about.
    const dir = readConfig().orchestratorMaySpawn ? spawnRequestsDir() : null;
    if (dir && existsSync(dir)) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
      for (const f of files) {
        if (liveWorkers.size >= maxWorkers) break;
        await processSpawnRequest(join(dir, f));
      }
    }

    // (3) GC preserved worktrees whose work has since integrated. Throttled to
    //     GC_SWEEP_MS and a no-op when nothing is preserved (the common case).
    const now = Date.now();
    if (preservedWorktrees.size > 0 && now - lastGcSweepAt >= GC_SWEEP_MS) {
      lastGcSweepAt = now;
      await gcPreservedWorktrees();
    }
  } catch (e) {
    console.error('[worker] tick error:', e);
  } finally {
    workerTickRunning = false;
  }
}

export function startEphemeralWorkerWatcher(): void {
  if (workerWatchTimer || !hive.enabled()) return;
  const dir = spawnRequestsDir();
  if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ } }
  workerWatchTimer = setInterval(() => { void ephemeralWorkerTick(); }, WORKER_TICK_MS);
}

export function stopEphemeralWorkerWatcher(): void {
  if (workerWatchTimer) { clearInterval(workerWatchTimer); workerWatchTimer = null; }
}

/** Snapshot of one live ephemeral worker for the renderer Workers tab. */
interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY already gone
  tokensUsed: number;
  tokenCap: number | null;      // effective cap (per-request or config default); null = unlimited
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** Snapshot of a preserved-but-not-yet-GC'd worktree for the tab. */
interface PreservedSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerWorkerIpc(): void {
  /** List live ephemeral workers (+ preserved worktrees awaiting GC) for the tab. */
  ipcMain.handle('workers:list', (): { live: WorkerSnapshot[]; preserved: PreservedSnapshot[]; maxWorkers: number } => {
    const cfg = readConfig();
    const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;
    const now = Date.now();
    const live: WorkerSnapshot[] = [...liveWorkers.values()].map((rec) => {
      const idle = ptyManager.idleFor(rec.workerId);
      const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
      return {
        workerId: rec.workerId,
        reqId: rec.reqId,
        name: rec.name ?? rec.workerId,
        baseBranch: rec.baseBranch,
        spawnedAt: rec.spawnedAt,
        ageMs: Math.max(0, now - rec.spawnedAt),
        idleMs: idle === undefined ? null : idle,
        tokensUsed: workerTokensUsed(rec.workerId),
        tokenCap: effCap > 0 ? effCap : null,
        hasSlack: !!rec.slack,
        releasing: !!rec.releasing,
        status: rec.releasing ? 'releasing' : 'working'
      };
    });
    const preserved: PreservedSnapshot[] = [...preservedWorktrees.values()].map((e) => ({
      workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt
    }));
    return { live, preserved, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) };
  });

  /** Manually stop a live ephemeral worker. Mirrors the done-release path: mark
   *  releasing, then kill + teardownPty runs the SAFETY-GATED worktree teardown
   *  (committed work is preserved, never force-discarded). Idempotent. teardownPty
   *  is called explicitly (D10) rather than left to the PTY's natural exit: kill()
   *  frees the manager's id slot synchronously, so by the time the process's real
   *  exit arrives the exit-handler's stale-id guard already misreads it as a
   *  reclaimed id and skips teardown — the worker would stay "live" in registry.json
   *  and fleet.json forever after this call. */
  ipcMain.handle('workers:stop', (_evt, workerId: string): { ok: boolean; error?: string } => {
    if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
    const rec = liveWorkers.get(workerId);
    if (!rec) return { ok: false, error: 'no such live worker' };
    if (rec.releasing) return { ok: true }; // already stopping
    rec.releasing = true;
    console.log(`[worker] manual stop requested for ${workerId}`);
    try { ptyManager.kill(workerId); } catch (e) { return { ok: false, error: String(e) }; }
    teardownPty(workerId);
    return { ok: true };
  });
}
