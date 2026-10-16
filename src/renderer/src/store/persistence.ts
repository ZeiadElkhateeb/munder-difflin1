/**
 * Where the store's durable state lives: localStorage keys, the shared roster file
 * (<harnessHome>/roster.json) mirror and its debounced flush, the load/persist helpers,
 * and the initial values the slices start from. Its load-time statements (claiming the
 * roster keys, priming the mirror, the beforeunload flush) run once, before the store.
 */
import { chooseRosterSource } from './rosterSource';
import type { Agent, QueuedMessage, SidebarTab } from './types';

export const LS_SIDEBAR_WIDTH = 'cth.sidebarWidth';

export const LS_SIDEBAR_TAB = 'cth.sidebarTab';

export const LS_AGENTS = 'cth.agents';

export const LS_ARCHIVED = 'cth.archivedAgents';

export const LS_RESTORABLE = 'cth.restorableAgents';

export const LS_SELECTED = 'cth.selectedId';

export const LS_QUEUES = 'cth.messageQueues';

/** Which hive this origin's roster keys were last written for. See rosterSource.ts. */
export const LS_ROSTER_HOME = 'cth.rosterHome';

export const LS_FOCUS_MODE = 'cth.prefersFocusMode';

// Fields that are large or transient — not worth persisting across reloads.
// contextTokens/contextLimit describe a LIVE session; persisting them showed a
// dead session's context gauge after a restart until the poll caught up.
export type PersistedAgent = Omit<Agent, 'recentAssistantText' | 'recentTextTs' | 'blockReason' | 'contextTokens' | 'contextLimit' | 'seedPrompt'>;

// ─── The roster mirror ──────────────────────────────────────────────────────
//
// localStorage is partitioned by ORIGIN, and the two ways this app runs do not
// share one: `npm run dev` serves the renderer from http://localhost:5173, a
// packaged build loads it from file://. So the roster — agents, their private
// notes, worktree paths, archived entries, parked queues — was invisible to
// whichever of the two you were not currently in, even though the hive on disk
// (sessions, memory, inboxes, tasks) was shared and intact the whole time.
//
// So we also mirror it to <harnessHome>/roster.json, which both sides reach by
// path. localStorage keeps being written byte-for-byte as before: it is the
// fallback when there is no file yet, and a standing backup afterwards. Main
// keeps every previous version of the file under roster-backups/.
export const fileRoster = (() => {
  try { return window.cth?.rosterReadSync?.() ?? null; } catch { return null; }
})();

/** Which hive we are opening, and which one this origin's localStorage was last
 *  written for. Both read synchronously, for the same reason the roster is: the
 *  store is built at module load, so an async answer would arrive too late. */
export const currentHome = (() => {
  try { return window.cth?.harnessHomeSync?.() ?? null; } catch { return null; }
})();

export const storedHome = (() => {
  try { return window.localStorage.getItem(LS_ROSTER_HOME); } catch { return null; }
})();

export const { useFileRoster, useLocalFallback } = chooseRosterSource({
  fileRoster,
  currentHome,
  storedHome
});

/** Claim this origin's roster keys for the hive we just opened. Written even
 *  when nothing loaded: from here on localStorage describes THIS hive, so the
 *  next hive we open knows not to adopt it. */
try {
  if (currentHome) window.localStorage.setItem(LS_ROSTER_HOME, currentHome);
} catch { /* noop */ }

/** The renderer's running copy of what should be on disk. Kept as a mutable
 *  mirror updated slice-by-slice rather than read back out of the store, because
 *  every persist* call happens INSIDE a zustand `set()` — `getState()` there
 *  still returns the pre-update state, so a snapshot built that way would
 *  reliably be one edit stale. */
export const rosterMirror: {
  agents: PersistedAgent[];
  archived: PersistedAgent[];
  restorable: PersistedAgent[];
  queues: Record<string, QueuedMessage[]>;
  selectedId: string | null;
} = { agents: [], archived: [], restorable: [], queues: {}, selectedId: null };

export let rosterFlush: ReturnType<typeof setTimeout> | null = null;

export function flushRosterNow(): void {
  if (rosterFlush) { clearTimeout(rosterFlush); rosterFlush = null; }
  try {
    void window.cth?.rosterWrite?.({
      version: 1,
      savedAt: new Date().toISOString(),
      agents: rosterMirror.agents,
      archived: rosterMirror.archived,
      restorable: rosterMirror.restorable,
      queues: rosterMirror.queues,
      selectedId: rosterMirror.selectedId
    });
  } catch { /* the file is a mirror — localStorage already took the write */ }
}

/** Coalesce a burst of persist* calls into one disk write. Agent edits arrive in
 *  clusters (spawn writes agents + selection + queues in the same tick). */
export function scheduleRosterFlush(): void {
  if (rosterFlush) return;
  rosterFlush = setTimeout(flushRosterNow, 500);
}

// Don't let a quit inside the debounce window drop the last edit. localStorage
// would still have it, but only for THIS origin — and the whole point is that
// the other origin can read it too.
try {
  window.addEventListener('beforeunload', flushRosterNow);
} catch { /* not a browser context (unit tests) */ }

export function slimAgents(agents: Agent[]): PersistedAgent[] {
  return agents.map(({ recentAssistantText, recentTextTs, blockReason, contextTokens, contextLimit, seedPrompt, ...rest }) => {
    void recentAssistantText; void recentTextTs; void blockReason; void contextTokens; void contextLimit; void seedPrompt;
    return rest;
  });
}

export function persistAgents(agents: Agent[], selectedId: string | null): void {
  const slim = slimAgents(agents);
  try {
    window.localStorage.setItem(LS_AGENTS, JSON.stringify(slim));
    window.localStorage.setItem(LS_SELECTED, selectedId ?? '');
  } catch { /* noop */ }
  rosterMirror.agents = slim;
  rosterMirror.selectedId = selectedId;
  scheduleRosterFlush();
}

/** Run-state an agent recomputes from its live pty on every reload. A patch made
 *  only of these is not worth a localStorage write; anything else is. Listed as
 *  the volatile set rather than the durable set on purpose — a new durable field
 *  then persists by default instead of being silently dropped. */
export const VOLATILE_AGENT_FIELDS = new Set<keyof Agent>([
  'status', 'action', 'progress', 'currentStation', 'carrying',
  'recentAssistantText', 'recentTextTs', 'blockReason',
  'contextTokens', 'contextLimit', 'lastPrompt'
]);

export function touchesDurableAgentField(patch: Partial<Agent>): boolean {
  return Object.keys(patch).some((k) => !VOLATILE_AGENT_FIELDS.has(k as keyof Agent));
}

/** The persisted list for one slice: the shared file when it has a roster,
 *  otherwise this origin's localStorage — but only when that localStorage was
 *  written for this hive. Returns [] on anything malformed. */
export function persistedSlice(
  key: string,
  fromFile: unknown[] | undefined
): PersistedAgent[] {
  if (useFileRoster) return Array.isArray(fromFile) ? (fromFile as PersistedAgent[]) : [];
  if (!useLocalFallback) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersistedAgent[]) : [];
  } catch {
    return [];
  }
}

export function loadPersistedAgents(): Agent[] {
  try {
    const parsed = persistedSlice(LS_AGENTS, fileRoster?.agents);
    if (!parsed.length) return [];
    // Reset volatile run-state; the PTY stream / mock loop will repopulate it.
    return parsed.map((a) => ({
      ...a,
      progress: 0,
      status: 'idle',
      action: 'reconnecting…',
      currentStation: 'desk',
      carrying: undefined,
      recentTextTs: Date.now(),
    }));
  } catch {
    return [];
  }
}

export function persistArchived(archived: Agent[]): void {
  const slim = slimAgents(archived);
  try {
    window.localStorage.setItem(LS_ARCHIVED, JSON.stringify(slim));
  } catch { /* noop */ }
  rosterMirror.archived = slim;
  scheduleRosterFlush();
}

export function loadPersistedArchived(): Agent[] {
  try {
    const parsed = persistedSlice(LS_ARCHIVED, fileRoster?.archived);
    if (!parsed.length) return [];
    // Archived agents have no live process — force the flag + clear run-state.
    return parsed.map((a) => ({
      ...a,
      archived: true,
      status: 'idle',
      ptyId: undefined,
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

export function persistRestorable(restorable: Agent[]): void {
  // Keeps contextTokens/contextLimit, unlike the other two: a restorable entry
  // is a spawn recipe for a session that has not been re-entered yet, so its
  // last known context size is still meaningful.
  const slim: PersistedAgent[] = restorable.map(({ recentAssistantText, recentTextTs, blockReason, seedPrompt, ...rest }) => {
    void recentAssistantText; void recentTextTs; void blockReason; void seedPrompt;
    return rest;
  });
  try {
    window.localStorage.setItem(LS_RESTORABLE, JSON.stringify(slim));
  } catch { /* noop */ }
  rosterMirror.restorable = slim;
  scheduleRosterFlush();
}

export function loadPersistedRestorable(): Agent[] {
  try {
    const parsed = persistedSlice(LS_RESTORABLE, fileRoster?.restorable);
    if (!parsed.length) return [];
    // No live process — clear run-state; the spawn recipe fields are what matter.
    return parsed.map((a) => ({
      ...a,
      status: 'idle',
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

export function persistQueues(queues: Record<string, QueuedMessage[]>): void {
  try {
    // Only keep non-empty queues so the key stays small.
    const slim: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(queues)) if (q.length) slim[id] = q;
    window.localStorage.setItem(LS_QUEUES, JSON.stringify(slim));
    rosterMirror.queues = slim;
    scheduleRosterFlush();
  } catch { /* noop */ }
}

export function loadPersistedQueues(): Record<string, QueuedMessage[]> {
  try {
    const parsed = useFileRoster
      ? (fileRoster?.queues as Record<string, QueuedMessage[]> | undefined)
      : useLocalFallback
        ? JSON.parse(window.localStorage.getItem(LS_QUEUES) ?? 'null') as Record<string, QueuedMessage[]> | null
        : null;
    if (!parsed || typeof parsed !== 'object') return {};
    // Defensively keep only well-formed entries.
    const out: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(parsed)) {
      if (Array.isArray(q)) {
        out[id] = q.filter((m) => m && typeof m.text === 'string' && typeof m.id === 'string');
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function loadPersistedSelectedId(agents: Agent[]): string | null {
  try {
    const id = useFileRoster
      ? fileRoster?.selectedId
      : useLocalFallback ? window.localStorage.getItem(LS_SELECTED) : null;
    return id && agents.some((a) => a.id === id) ? id : (agents[0]?.id ?? null);
  } catch {
    return agents[0]?.id ?? null;
  }
}

export const initialSidebarWidth = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_WIDTH);
    const n = v ? parseInt(v, 10) : NaN;
    if (!Number.isNaN(n) && n >= 320 && n <= 1200) return n;
  } catch { /* noop */ }
  return 420;
})();

export const initialSidebarTab: SidebarTab = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_TAB);
    if (v === 'terminal' || v === 'messages' || v === 'traces' || v === 'git') return v;
  } catch { /* noop */ }
  return 'terminal';
})();

/** Does the user want focus mode as their default view?
 *
 *  Persisted as a BOOLEAN, deliberately not as the focused agent's id. The id is
 *  meaningless across a restart: that agent may have been closed, or its PTY may
 *  not come back, and restoring a stale one lands us straight in the dangling
 *  reference `refocusAfterRemoval` exists to prevent. The preference is "I work
 *  in focus mode", so on load we resolve it against whoever is selected now. */
export const initialPrefersFocusMode = (() => {
  try {
    return window.localStorage.getItem(LS_FOCUS_MODE) === '1';
  } catch { /* noop */ }
  return false;
})();

export const initialAgents = loadPersistedAgents();

export const initialArchivedAgents = loadPersistedArchived();

export const initialRestorableAgents = loadPersistedRestorable();

export const initialSelectedId = loadPersistedSelectedId(initialAgents);

export const initialQueues = loadPersistedQueues();

// Prime the mirror with whatever we just loaded, so a later persist of ONE slice
// writes a complete file rather than blanking the slices it didn't touch.
rosterMirror.agents = slimAgents(initialAgents);

rosterMirror.archived = slimAgents(initialArchivedAgents);

rosterMirror.restorable = slimAgents(initialRestorableAgents);

rosterMirror.queues = initialQueues;

rosterMirror.selectedId = initialSelectedId;

// First run with the file: seed it from this origin's localStorage. Only when
// there is something to seed — writing an empty file here would hand a blank
// roster to the other side, which is precisely the outcome being designed out.
if (useLocalFallback && rosterMirror.agents.length + rosterMirror.archived.length + rosterMirror.restorable.length > 0) {
  scheduleRosterFlush();
}

export let queuedSeq = 0;

/** Process-unique id for a queued message (timestamp + counter avoids collisions
 *  when several are queued within the same millisecond). */
export function newQueuedId(): string {
  queuedSeq += 1;
  return `q-${Date.now()}-${queuedSeq}`;
}
