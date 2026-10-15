/**
 * The state useHive's effect hooks share: per-agent refs (nudge dedup, flush times,
 * boot grace, revive guards, …) plus the PTY-quiescence reader. Created once per
 * useHive call so every hook sees the same objects.
 */
import { useRef } from 'react';
import { useStore } from '@/store/store';

export function useHiveContext() {
  // Per-agent dedup for the inbox-wake nudge: every inbox message id we have
  // already nudged this agent about. A SET, not a high-water mark.
  //
  // This used to hold one string — the lexicographically largest id in the inbox,
  // read as "the newest". Message ids are usually `<timestamp>-<rand>`, so that
  // held, but an agent may set its own `id` in the outbox JSON and the hive keeps
  // it verbatim (hive.ts normalize: `partial.id ?? ...`). One such id in god's
  // inbox — `dev15-progress-canvas-v4` — sorts above EVERY `2026-*` timestamp and
  // never drains, so the "newest" id was frozen on it: Michael was nudged once per
  // app launch and then never again, however much real mail piled up behind it.
  // Tracking the ids we have seen has no such ordering assumption, and it keeps
  // the property the high-water mark was there for: draining removes ids from the
  // INBOX without adding anything new, so a drain still produces no nudge.
  //
  // Note what this set does NOT do: it never shrinks. Ids accumulate for the life
  // of the window (a restart clears it), because forgetting an id we have already
  // nudged for would re-nudge the moment that message reappeared in a listing. The
  // cost is a few tens of bytes per message, which for a 24/7 floor is real but
  // negligible next to a stalled agent. Evicting ids that have left the inbox would
  // bound it exactly; deliberately not done here to keep this fix minimal.
  const nudged = useRef<Record<string, Set<string>>>({});
  // Per-agent context size at the last auto-/compact queued. See the latch note
  // in the context-trigger effect: an idle agent's token count is frozen, so
  // without this the pressure gate re-fires on the identical number every cycle.
  const lastCompactUsed = useRef<Record<string, number>>({});
  // Per-agent timestamp of the last queued-message we submitted. Guards against
  // re-sending the next message before the agent's hooks have flipped it to
  // 'working' (there's a short window where it still reads 'idle' right after we
  // type into it). One message per cooldown keeps delivery strictly one-by-one.
  const lastFlush = useRef<Record<string, number>>({});
  // Queue-drain delivery tracking (#36): a message now stays IN the queue until
  // its PTY write chain resolves, so `inFlightSends` (message ids mid-write)
  // stops a store-update burst from double-sending the head, and `sendFailures`
  // bounds retries — after MAX_SEND_ATTEMPTS failed writes the message is
  // dropped WITH a console.warn instead of being silently destroyed.
  const inFlightSends = useRef<Set<string>>(new Set());
  const sendFailures = useRef<Record<string, number>>({});
  // In-flight spawn guard so a re-render / StrictMode double-mount can't spawn
  // Michael twice (the window between the listPtys check and spawnPty is racy).
  const godSpawning = useRef(false);
  // Per-agent timestamp until which auto-typers (inbox-wake #3, queue-drain #4)
  // must leave the agent alone — set while its boot sequence is typing so nothing
  // collides with /remote-control + the orientation prompt.
  const bootGraceUntil = useRef<Record<string, number>>({});
  // Agents whose one-time TUI protocol seed (Crush, seedDelivery:'type-into-tui')
  // has already been typed — guards effect #3b against re-seeding. (ondev-b)
  const seeded = useRef<Set<string>>(new Set());
  const seenTerminalHandoffs = useRef<Set<string>>(new Set());
  // Per-pty timestamp guarding auto-revive (effect #7) against a double-respawn
  // when power-resume + screen-unlock arrive back-to-back: an id revived (or
  // mid-revive) within REVIVE_DEBOUNCE_MS is skipped. Set BEFORE the async spawn
  // so a re-entrant event can't race a second respawn for the same id.
  const reviving = useRef<Record<string, number>>({});
  // Reactive so the assistant bootstrap (effect #1b) re-runs once Michael is ready.
  const godStatus = useStore((s) => s.godStatus);
  // Per-pty `lastOutputAt`, refreshed by the quiescence sweep (#2e) and read by
  // the queue drain (#4) so it can tell a terminal parked at its prompt from one
  // mid-turn. Kept here rather than fetched again in #4 — #2e already polls
  // listPtys on exactly the cadence the drain needs, and one reading keeps the
  // two loops from disagreeing about whether an agent is quiet.
  const ptyLastOutput = useRef<Record<string, number>>({});
    /** How long this terminal has been silent, or null when we have no reading
   *  (never polled, PTY gone, or it has emitted nothing at all). canDeliverToAgent
   *  fails closed on null — unmeasured silence is not evidence of silence.
   *  Hook-level (not effect-local) because both the drain effect and the
   *  context-trigger effect gate delivery through the same check. */
  const ptyQuietMs = (ptyId: string, now: number): number | null => {
    const last = ptyLastOutput.current[ptyId];
    return typeof last === 'number' && last > 0 ? now - last : null;
  };
  // #5C/#7C.4 — latest circuit-breaker level per agent. When 'constrained'/
  // 'stopped' the avatar is pinned to 'looping' and hook events must NOT flip it
  // back to 'working' (the flicker the spec calls out); only a genuine Stop clears it.
  const breakerLevel = useRef<Record<string, string>>({});

  return {
    nudged,
    lastCompactUsed,
    lastFlush,
    inFlightSends,
    sendFailures,
    godSpawning,
    bootGraceUntil,
    seeded,
    seenTerminalHandoffs,
    reviving,
    godStatus,
    ptyLastOutput,
    ptyQuietMs,
    breakerLevel
  };
}

/** Refs and values every useHive effect hook shares; one instance per useHive call. */
export type HiveContext = ReturnType<typeof useHiveContext>;
