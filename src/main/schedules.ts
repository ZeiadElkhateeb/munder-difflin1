/**
 * Timed work: recurring missions (auto-dispatch, heartbeat), context triggers
 * (auto-compact / auto-clear cadences), and their IPC.
 */
import { ipcMain } from 'electron';
import { readConfig, writeConfig, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, type ScheduledMission } from './config';
import { normalizeWeekly, weeklyDelayMs } from '../shared/weeklySchedule';
import { DEFAULT_CONTEXT_TRIGGER, type ContextRule, type ContextTriggerConfig } from '../shared/triggers';
import { armHeartbeat } from './heartbeat';
import { hive, persist } from './services';
import { liveWebContents } from './windows';

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
export const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
export function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
export function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;
    // A weekly mission (day-of-week + time) is armed below and does NOT need an
    // interval, so the interval guard has to come after that branch — it used to
    // be folded into the line above and would have rejected every one of them.
    const weekly = m.kind === 'heartbeat' ? null : normalizeWeekly(m.weekly);
    if (!weekly && !(m.intervalMs > 0)) continue;
    // Heartbeat (Lane A #1) opts out of the fixed setInterval and self-reschedules
    // with an adaptive cadence. Registered into the same missionTimers map so
    // clearMissionTimers() tears it down identically on quit/reset.
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => {
      try {
        // A 'compact' maintenance mission (maint-1) is compaction-ONLY: it carries
        // no dispatch body/target, so skip the hive.send and just fire auto-compact.
        // Gate on `kind!=='compact'` ALONE — that already excludes the compact mission;
        // we deliberately do NOT add `&& m.body`, so other (dispatch) missions keep
        // their prior behaviour, including the historical empty-body send (Pam N1).
        if (m.kind !== 'compact' && hive.enabled()) {
          hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
        }
        // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the
        // renderer, which queues a /compact per agent (deduped — never two at
        // once) and delivers it only when that agent goes idle (its drain loop),
        // so a working agent compacts between steps, never mid-step.
        //
        // The CADENCE now belongs to the context trigger, not to a mission — but
        // the legacy per-mission `autoCompact` flag keeps working, routed through
        // the same emit so there is exactly ONE path from main to the renderer.
        // It carries the context trigger's current rule so a mission-driven
        // compaction obeys the same pressure thresholds as a trigger-driven one.
        if (m.autoCompact || m.kind === 'compact') {
          emitContextTrigger('compact', contextRule('compact'));
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
        // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
        try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    const entry: MissionTimer = {};
    if (weekly) {
      // Weekly self-reschedules: there is no steady interval to settle into,
      // because the gap between two slots varies (Fri to Mon is not Mon to Wed,
      // and the week the clocks change is not 168 hours long).
      //
      // `justFired` is a spin guard, not a nicety. weeklyDelayMs returns 0 for a
      // slot that was missed and not yet run, and it learns "already run" from
      // the persisted lastFiredAt — so if fire()'s writeConfig ever failed, the
      // next computation would return 0 again, forever. Passing `now` as the
      // last-fired floor after a fire makes the catch-up branch unreachable, so
      // the worst case is a lost stamp rather than a hot loop.
      const rearm = (justFired: boolean): void => {
        const now = Date.now();
        const persisted = (readConfig().missions ?? []).find((x) => x.id === m.id)?.lastFiredAt ?? 0;
        const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
        if (delay === null) return;
        entry.timeout = setTimeout(() => { fire(); rearm(true); }, delay);
      };
      rearm(false);
      missionTimers.set(m.id, entry);
      continue;
    }
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

// ─── Context trigger (auto-compact / auto-clear own their own timers) ────────
// Compaction used to ride on a mission (`compact-maintenance`), which meant the
// operator had TWO competing controls for one behaviour — a schedule with an
// interval and a trigger with a cadence. The mission is retired (see the
// retirement migration in ensureDefaultMissions); these timers are the single
// remaining source of scheduled context maintenance.
//
// Main owns only the CADENCE. The pressure gate (`minContextPct`) needs each
// agent's live context usage, which only the renderer has, so the whole rule
// rides along in the event and the renderer decides which agents actually get
// the command. That split is why the payload carries the rule rather than a bare
// "go" signal.

/** Timers for the two halves, keyed by action. Same two-phase shape as
 *  `missionTimers` (a setTimeout for the remaining time, then a steady interval)
 *  so a partially-elapsed cadence survives a re-arm. */
const contextTimers = new Map<'compact' | 'clear', MissionTimer>();

/** `ContextRule` has no `lastFiredAt` (unlike `ScheduledMission`), so the last-run
 *  instants live in the durable kv store instead. Without them every re-arm —
 *  boot, a settings edit, a wake from sleep — would restart a 2h cadence from
 *  zero, and an operator who edits the rule twice a day would never see it fire. */
const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';
let contextLastRun: Record<string, number> | null = null;

function contextRunMap(): Record<string, number> {
  if (!contextLastRun) {
    try { contextLastRun = persist.getKv<Record<string, number>>(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
    catch { contextLastRun = {}; }
  }
  return contextLastRun;
}

/** When the rule last ran. An UNRECORDED half is stamped NOW rather than read as
 *  the epoch: `remaining` would otherwise clamp to 0 and compact every terminal
 *  the instant the app boots. It is the same trap `ensureDefaultMissions` avoids
 *  by stamping `lastFiredAt` when it seeds a mission — a first launch should wait
 *  a full cadence, not open with an interruption. */
function contextLastRunAt(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const v = map[action];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return stampContextRun(action);
}

function stampContextRun(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const at = Date.now();
  map[action] = at;
  try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
  return at;
}

/** The live rule for one half, deep-filled. `readConfig` already fills both
 *  halves, so the default is only a belt-and-braces fallback. */
function contextRule(action: 'compact' | 'clear'): ContextRule {
  return readConfig().contextTrigger?.[action] ?? DEFAULT_CONTEXT_TRIGGER[action];
}

/** Clear and forget both context timers (setTimeout + setInterval handles). */
export function clearContextTimers(): void {
  for (const t of contextTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  contextTimers.clear();
}

/** Ask the renderer to run one half of the context trigger.
 *
 *  Both callers funnel through here — the legacy per-mission `autoCompact` flag
 *  and the context trigger's own timer — so there is exactly one path from main
 *  to the renderer for each action. */
function emitContextTrigger(action: 'compact' | 'clear', rule: ContextRule): void {
  try { liveWebContents()?.send('trigger:context', { action, rule }); } catch { /* window gone */ }
  // TRANSITIONAL ALIAS: the renderer still carries the pre-Triggers
  // `mission:autoCompact` listener as a fallback. Both fire for compact until
  // every consumer has moved to `trigger:context`; then this line goes.
  if (action === 'compact') {
    try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
  }
}

/** (Re)arm both context timers from persisted config. Clear-then-arm, so calling
 *  it after a settings change, on boot, or on wake from sleep can never stack
 *  duplicates. Honors elapsed-time-since-last-run exactly like mission arming:
 *  an overdue rule fires ONCE and then settles into its steady cadence. */
export function syncContextTriggers(): void {
  clearContextTimers();
  for (const action of ['compact', 'clear'] as const) {
    const rule = contextRule(action);
    if (!rule.enabled || !(rule.everyMs > 0)) continue;
    const fire = (): void => {
      try {
        stampContextRun(action);
        // Re-read: the operator may have edited the message/thresholds since the
        // timer was armed, and the renderer should act on what's current.
        emitContextTrigger(action, contextRule(action));
      } catch (e) {
        console.error('[triggers] context', action, e);
      }
    };
    const remaining = Math.max(0, rule.everyMs - (Date.now() - contextLastRunAt(action)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, rule.everyMs);
    }, remaining);
    contextTimers.set(action, entry);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
export function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // Seed the built-in heartbeat (Lane A #1) once. Shipped DISABLED, so it just
  // appears in the SCHEDULES panel for the user to turn on; lastFiredAt = now so
  // it doesn't fire on the very first launch after a user enables it.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }

  // maint-1 RETIREMENT: `compact-maintenance` is no longer a mission. Scheduled
  // compaction is now the CONTEXT TRIGGER's job, so the operator has exactly one
  // control (a cadence + a pressure gate + an editable message) instead of two
  // that could disagree — a mission saying "hourly" while the trigger said "2h"
  // was a real, unresolvable conflict.
  //
  // The carry-over preserves the operator's decisions: whether compaction was ON
  // and how often. It runs at most once per install, and its guard is the
  // mission's own ABSENCE — nothing seeds `compact-maintenance` any more, so once
  // this has removed it there is nothing left to carry and a later hand-edit of
  // the trigger can never be clobbered. That keeps the `*Seeded` convention's
  // promise (exactly once, ever) without a config flag that would only ever be
  // read here; `compactMaintenanceSeeded` is left set so nothing re-seeds it.
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find((m) => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter((m) => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // A hand-tuned interval is a decision; only a missing/absurd one falls
          // back to whatever the trigger already carries.
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs
        }
      },
      compactMaintenanceSeeded: true
    });
    // …and its elapsed time, so retiring the mission mid-cycle doesn't restart a
    // 2h cadence from zero (the timers honour last-run exactly as arming did).
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0) {
      const map = contextRunMap();
      map.compact = retiring.lastFiredAt;
      try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
    }
    console.log('[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`);
  }

  // autoCompact RETIREMENT: the flag above was only ever half-removed. Retiring
  // `compact-maintenance` left `autoCompact: true` sitting on the ops standup, so
  // a default install still asked for compaction on TWO cadences — hourly from the
  // standup, 2-hourly from the trigger — which is precisely the disagreement that
  // retirement claims to have ended. (config.ts even documented a migration that
  // strips this; it did not exist.)
  //
  // Strip it wherever it survives. This is a pure de-duplication, not a behaviour
  // change: contextTrigger.compact still runs, still on the user's own cadence and
  // pressure gate, and it is what actually performed every one of these
  // compactions already — both paths have called emitContextTrigger since Triggers
  // landed. Idempotent, so it costs one no-op scan per boot once clean.
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some((m) => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => {
        void autoCompact;
        return rest;
      })
    });
    console.log('[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts');
  }
}

/** Clamp one half of the context trigger. The renderer is not trusted with the
 *  arming maths: a zero/negative/NaN `everyMs` would arm a runaway timer, and an
 *  out-of-range percentage would silently disable (or permanently trip) the
 *  pressure gate. */
function sanitizeContextRule(patch: Partial<ContextRule> | undefined, current: ContextRule): ContextRule {
  const p = (patch ?? {}) as Partial<ContextRule>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 60_000, 86_400_000),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current.message
  };
}

/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerScheduleIpc(): void {
  // ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
  ipcMain.handle('missions:list', () => readConfig().missions ?? []);
  ipcMain.handle('missions:save', (_evt, missions) => {
    // lastFiredAt is scheduler-owned. The renderer loads missions once and later
    // sends back a STALE array, so a wholesale write would clobber every
    // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
    // lastFiredAt (almost always the persisted one) so the UI can never erase it.
    const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
    const persistedById = new Map(
      (readConfig().missions ?? []).map((m) => [m.id, m] as const)
    );
    const merged = incoming.map((m) => {
      const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
      const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
      return { ...m, lastFiredAt };
    });
    writeConfig({ missions: merged });
    syncMissions();
    return { ok: true };
  });

  // ─── IPC: Triggers — context (auto-compact / auto-clear) ────────────────────
  ipcMain.handle('triggers:getContext', () => readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
  ipcMain.handle('triggers:setContext', (_evt, arg: unknown) => {
    const current = readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    const p = (arg ?? {}) as Partial<ContextTriggerConfig>;
    const next: ContextTriggerConfig = {
      compact: sanitizeContextRule(p.compact, current.compact),
      clear: sanitizeContextRule(p.clear, current.clear)
    };
    writeConfig({ contextTrigger: next });
    // The timers ARE the setting — a cadence saved but not re-armed would keep
    // firing on the old rhythm until the next boot.
    syncContextTriggers();
    return next;
  });
}
