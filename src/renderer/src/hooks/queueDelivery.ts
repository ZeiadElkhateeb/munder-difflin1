/** Run one queued delivery and acknowledge it only after the sender resolves.
 * Rejections deliberately leave the queue item untouched for the next retry. */
export async function deliverWithAcknowledgement(
  send: () => Promise<void>,
  acknowledge: () => void
): Promise<boolean> {
  try {
    await send();
    acknowledge();
    return true;
  } catch {
    return false;
  }
}

/**
 * May the drain type into this agent's terminal right now?
 *
 * The gate used to be `status === 'idle'`, full stop, and that stranded mail
 * indefinitely. `looping` is not a terminal state the agent recovers from on its
 * own — it is the circuit breaker's PIN, re-asserted on every beat for as long
 * as the agent is `constrained` or `stopped`. The PTY-quiescence fallback only
 * un-pins `working`, so a breaker-armed agent never returned to `idle` and its
 * queue never drained. Observed live: an agent over its token cap sat pinned
 * while a nudge enqueued two seconds after the message landed went undelivered
 * for minutes, until something outside the app woke it.
 *
 * That is self-defeating, because the breaker STEERS by mailing the agent it
 * armed ("stop, write a plan, send it to god"). Under the old gate the one
 * message meant to unwedge a wedged agent was exactly the message that could
 * never arrive.
 *
 * So a pinned agent is deliverable once its terminal has been silent for
 * `quiesceMs` — the same evidence the idle fallback already trusts to decide a
 * turn is over. The pin stays on the avatar and the badge; it just stops
 * doubling as a delivery lock.
 *
 * Everything else still holds the prompt:
 *   - `working` / `thinking`: mid-turn. The quiescence fallback flips a genuinely
 *     finished turn to `idle`, and then the ordinary gate applies.
 *   - `waiting` / `blocked`: an interactive prompt is on screen. The drain ends
 *     every delivery with Enter, which would ANSWER it — the same reason the
 *     one-time TUI seed refuses to type at those two statuses.
 *
 * Fails CLOSED on an unknown `ptyQuietMs` (no reading, or a PTY that has never
 * emitted): silence we cannot measure is not evidence of silence.
 */
export function canDeliverToAgent(
  status: string,
  ptyQuietMs: number | null,
  quiesceMs: number
): boolean {
  if (status === 'idle') return true;
  if (status !== 'looping') return false;
  return ptyQuietMs !== null && ptyQuietMs >= quiesceMs;
}

/** Why the drain is holding the front of a queue, or null when it may type. */
export type DeliveryBlock = 'not-deliverable' | 'paused' | 'boot-grace' | 'user-owns-prompt' | 'cooldown';

export interface DeliveryGateInput {
  now: number;
  status: string;
  ptyQuietMs: number | null;
  quiesceMs: number;
  /** Floor-wide / per-agent auto-delivery pause (Command Center). */
  autoDeliveryPaused: boolean;
  /** The user released this message with "send now". */
  manual: boolean;
  /** Epoch ms until which the agent is still painting its boot sequence. */
  bootGraceUntil: number;
  /** Lazily asks the terminal whether the user owns the prompt (a draft or an
   *  open menu). Only consulted once every cheaper gate has passed. */
  terminalSafe: () => boolean;
  /** Epoch ms of the last delivery to this agent (0 = never). */
  lastFlushAt: number;
  cooldownMs: number;
}

/**
 * The drain's gates, in order, for one message at the front of one queue. Every
 * automatic write into an agent's PTY passes here (docs/message-queue.md §2):
 *
 *   1. the agent can take input (canDeliverToAgent) — `manual` does NOT bypass
 *      this: it is a don't-type-mid-stream safety check, not a policy;
 *   2. auto-delivery is not paused — the ONE gate "send now" releases;
 *   3. the boot sequence is over;
 *   4. the user does not own the prompt;
 *   5. the per-agent cooldown has passed (back-to-back sends jam the TUI).
 */
export function deliveryBlocker(g: DeliveryGateInput): DeliveryBlock | null {
  if (!canDeliverToAgent(g.status, g.ptyQuietMs, g.quiesceMs)) return 'not-deliverable';
  if (g.autoDeliveryPaused && !g.manual) return 'paused';
  if (g.bootGraceUntil >= g.now) return 'boot-grace';
  if (!g.terminalSafe()) return 'user-owns-prompt';
  if (g.now - g.lastFlushAt < g.cooldownMs) return 'cooldown';
  return null;
}

/** Count one failed PTY write for a message. Returns 'drop' once it has failed
 *  `maxAttempts` times (and forgets it), so the drain never spins forever on a
 *  dead terminal the store still believes is idle (#113). */
export function noteSendFailure(
  failures: Record<string, number>,
  messageId: string,
  maxAttempts: number
): { verdict: 'retry' | 'drop'; attempts: number } {
  const attempts = (failures[messageId] ?? 0) + 1;
  if (attempts >= maxAttempts) {
    delete failures[messageId];
    return { verdict: 'drop', attempts };
  }
  failures[messageId] = attempts;
  return { verdict: 'retry', attempts };
}

/** The subset of a QueuedMessage this module needs. Kept structural so the
 *  gate is testable without dragging the store (and zustand) into the test. */
export interface DeliveryGateMessage {
  precondition?: 'inbox-nonempty';
}

export type PreconditionVerdict = 'send' | 'drop';

/** Re-check a queued message's delivery-time precondition, immediately before it
 *  is typed into a PTY.
 *
 *  A queue item is decided at enqueue time and delivered an arbitrary interval
 *  later, so some messages describe a world that may no longer exist by the time
 *  their turn comes. The inbox-wake nudge is the motivating case: an agent that
 *  is already awake routinely drains its whole inbox during the same turn the
 *  nudge was queued from, and delivering it afterwards spends a full turn
 *  discovering there is nothing to read.
 *
 *  Returns 'drop', never 'defer': a stale message left at the head of the queue
 *  would block every message behind it forever.
 *
 *  Fails OPEN. If the inbox cannot be read we send, because a spurious nudge
 *  costs one turn whereas a swallowed one can leave real mail unread
 *  indefinitely. */
export async function checkPrecondition(
  message: DeliveryGateMessage,
  readInbox: () => Promise<{ id?: string }[]>
): Promise<PreconditionVerdict> {
  if (message.precondition !== 'inbox-nonempty') return 'send';
  try {
    return (await readInbox()).length > 0 ? 'send' : 'drop';
  } catch {
    return 'send';
  }
}
