/**
 * Effects 2e–4: everything that ends with text typed into an agent's terminal — terminal
 * work-order handoffs, the PTY-quiescence idle fallback, the inbox-wake nudge, the one-time
 * TUI seed, and the queue drain (the ONLY writer; see docs/message-queue.md).
 */
import { useEffect } from 'react';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { inferAgentProvider, type HarnessConfig } from '@/store/config';
import { inboxNudgeText } from '../../../../shared/hiveNudge';
import { isTerminalAutomationSafe } from '@/components/terminalPool';
import { canDeliverToAgent, deliverWithAcknowledgement, checkPrecondition, deliveryBlocker, noteSendFailure } from '../queueDelivery';
import { GOD_ID, QUIESCE_IDLE_MS, QUIESCE_POLL_MS, BOOT_GRACE_MS, SEED_BOOT_MS, withStandingGoal, submitToPty, terminalWorkOrderPrompt } from './shared';
import type { HiveContext } from './context';

export function useMessageDelivery(config: HarnessConfig | null, ctx: HiveContext): void {
  const { nudged, lastCompactUsed, lastFlush, sendFailures, bootGraceUntil, seeded, seenTerminalHandoffs, ptyLastOutput, ptyQuietMs, breakerLevel } = ctx;

  // 2e) Non-Claude providers cannot drain hive inbox. Direct hive mail to them
  //     arrives here as a terminal work order and is queued through the same
  //     idle-only PTY drain as human-composed messages.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveTerminalHandoff((msg) => {
      if (seenTerminalHandoffs.current.has(msg.id)) return;
      const { agents, enqueueMessage, messageQueues } = useStore.getState();
      const target = agents.find((a) => a.id === msg.to);
      if (target?.ptyId) {
        const marker = `Message: ${msg.id}`;
        if ((messageQueues[target.id] ?? []).some((queued) => queued.text.includes(marker))) return;
        seenTerminalHandoffs.current.add(msg.id);
        enqueueMessage(target.id, terminalWorkOrderPrompt(msg));
        return;
      }
      seenTerminalHandoffs.current.add(msg.id);
      enqueueMessage(
        GOD_ID,
        [
          `Terminal handoff failed for ${msg.to}: ${msg.subject}`,
          '',
          `Message ${msg.id} from ${msg.from} could not be queued because ${msg.to} has no live PTY. Route it manually or respawn the agent.`
        ].join('\n')
      );
    });
  }, [config?.onboardingComplete]);
  // 2e) PROVIDER-AGNOSTIC PTY-QUIESCENCE IDLE FALLBACK (the linchpin that makes
  //     canReceiveInbox:true safe for the live-unverified OpenCode/Crush/pi bridges).
  //     Hook events are the authoritative status source, but a bridge whose turn-end
  //     signal (Stop/session.idle/agent_end) doesn't fire leaves the agent pinned
  //     'working' — and BOTH delivery paths (#3 nudge, #4 queue-drain) are idle-gated,
  //     so the agent silently stops draining mail. usePtyParser has a 4s idle drift,
  //     but it's Claude-TUI-tuned AND only runs for the mounted terminal — a
  //     backgrounded god gets none. This is the floor-wide, provider-agnostic backstop:
  //     it reads each live PTY's lastOutputAt (already tracked in the main process) and
  //     flips any 'working' agent quiet for QUIESCE_IDLE_MS to idle so the nudge can
  //     drain it. Safe because a genuinely-working agent (incl. a long streaming tool)
  //     keeps emitting bytes; a false idle self-corrects on the next hook event.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const ptys = await window.cth.listPtys().catch(() => []);
      const lastOut: Record<string, number> = {};
      for (const p of ptys) lastOut[p.id] = p.lastOutputAt;
      // Publish BEFORE the early return and before the 'working' filter below,
      // so the drain (#4) also gets a reading for breaker-pinned agents — and so
      // a vanished PTY clears its entry instead of leaving a stale one.
      ptyLastOutput.current = lastOut;
      if (!ptys.length) return;
      const now = Date.now();
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.status !== 'working') continue;
        // Never fight the breaker pin (a constrained/stopped agent stays 'looping')
        // or a still-booting agent (its boot sequence is mid-type).
        const bl = breakerLevel.current[a.id];
        if (bl === 'constrained' || bl === 'stopped') continue;
        if ((bootGraceUntil.current[a.id] ?? 0) > now) continue;
        const last = lastOut[a.ptyId];
        if (typeof last === 'number' && last > 0 && now - last > QUIESCE_IDLE_MS) {
          updateAgent(a.id, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    }, QUIESCE_POLL_MS);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);
  // 3) Wake agents holding unread inbox messages. The assistant is send-only
  //    (it never receives inbox mail), so it's excluded.
  //
  //    QUEUES the nudge rather than typing it. This loop used to write straight
  //    into the terminal, which made it the one automatic writer that could land
  //    on top of whatever the user was typing — its text fused onto the user's
  //    half-written line and the pair got submitted as one garbled prompt. Going
  //    through the queue means effect #4 owns every decision about when a
  //    terminal may be typed into: idle, off cooldown, past boot grace, delivery
  //    not paused, and no user draft in the way. One gate, one place, and this
  //    loop stops needing prompt logic of its own. /compact (effect #6) has
  //    always worked this way.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const agents = useStore.getState().agents.filter((a) => a.ptyId);
      for (const a of agents) {
        try {
          const inbox = await window.cth.hiveInbox(a.id);
          // Nudge on any id we have not nudged for yet (#130's per-id Set).
          // Draining shrinks the set and introduces nothing new, so this POLL
          // stays quiet; a genuinely new message fires regardless of how its id
          // happens to sort.
          //
          // That reasoning covers the poll only — it does NOT survive the gap
          // between enqueue and delivery, which is why the nudge carries an
          // 'inbox-nonempty' precondition that the drain re-checks before typing.
          // Without it: mail lands and queues a nudge, the already-awake agent
          // drains the whole inbox in that same turn, and the nudge is typed into
          // an empty inbox afterwards — a wasted turn, and the most expensive one
          // on the floor when the agent is god.
          const seen = nudged.current[a.id] ?? (nudged.current[a.id] = new Set());
          const fresh = inbox.filter((m) => m.id && !seen.has(m.id));
          if (fresh.length) {
            // Name the ids: the nudge is queued now and typed whenever the agent
            // next goes idle, so it can arrive long after the agent drained and
            // filed this very mail. Carrying the ids is what lets it tell
            // "already handled" from "woken for nothing". The queue keeps only
            // one nudge pending per agent (see enqueueMessage), so a suppressed
            // copy's ids stay unnamed — hence the text points at the pending
            // inbox as the authority rather than at the list.
            useStore.getState().enqueueMessage(
              a.id,
              inboxNudgeText(fresh.map((m) => m.id)),
              { precondition: 'inbox-nonempty' }
            );
            for (const m of fresh) seen.add(m.id);
          }
        } catch { /* ignore */ }
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);
  // 3b) Seed a fresh "type-into-tui" worker (Crush) with the hive protocol. Its
  //     bare TUI rejects a positional seed (Cobra reads it as a subcommand →
  //     `Unknown command`), so the main process spawns it bare and hands the
  //     protocol back as `seedPrompt`; we TYPE it as the worker's first turn after a
  //     boot-grace (TUI finished painting), ONCE per agent. Routed through the SAME
  //     per-pty submit chain + boot-grace as the inbox-wake nudge so the seed and a
  //     nudge can never jam onto one line. (god-as-Crush is seeded in its own boot
  //     sequence above; this covers workers.) (ondev-b)
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(() => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.isGod || !a.seedPrompt || seeded.current.has(a.id)) continue;
        seeded.current.add(a.id);
        const ptyId = a.ptyId;
        const seed = a.seedPrompt;
        // Hold the nudge/quiesce typers off this agent until the seed lands + settles.
        bootGraceUntil.current[a.id] = Date.now() + BOOT_GRACE_MS;
        // Clear the record now so it isn't re-seen (the ref also guards) or persisted.
        updateAgent(a.id, { seedPrompt: undefined });
        setTimeout(() => {
          // Permission-prompt safety (#5): if the worker surfaced an approval /
          // needs-human prompt while its TUI booted ('waiting'/'blocked'), the
          // seed's trailing Enter would confirm it. Put the seed back and let a
          // later tick retry once the prompt clears; if the agent vanished
          // (killed mid-boot), don't type into its orphaned pty at all.
          const live = useStore.getState().agents.find((x) => x.id === a.id);
          if (!live) return;
          if (live.status === 'waiting' || live.status === 'blocked') {
            seeded.current.delete(a.id);
            useStore.getState().updateAgent(a.id, { seedPrompt: seed });
            return;
          }
          submitToPty(
            ptyId,
            withStandingGoal(live, seed),
            inferAgentProvider(live.command, live.provider)
          )
            .catch(() => { /* pty may have died */ });
        }, SEED_BOOT_MS);
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);
  // 4) Drain each agent's queued messages to its terminal, one at a time, the
  //    moment the agent goes idle. This is what lets the user keep sending
  //    messages while the agent's "cloud terminal" is mid-run: the messages
  //    park in the store and get typed in (and submitted) as soon as it's free.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const FLUSH_COOLDOWN_MS = 4500;
    // A message that fails this many PTY writes (dead/crashed pty that the store
    // still thinks is idle) is dropped WITH a console.warn — bounded so the drain
    // never spins forever on a corpse, loud so the loss is diagnosable. (#113)
    const MAX_SEND_ATTEMPTS = 3;
    const inFlight = new Set<string>();
    const sendFailures: Record<string, number> = {};


    // Send the front of `srcId`'s queue into `target`'s pty (verbatim or wrapped),
    // gated on the target being idle, free of interactive menus, and off
    // cooldown. The queue item is acknowledged only after BOTH PTY writes
    // succeed; failures stay visible and retry automatically (bounded by
    // MAX_SEND_ATTEMPTS so the drain never spins forever on a corpse).
    const dispatch = async (
      srcId: string,
      target: Agent | undefined,
      wrap?: (m: QueuedMessage) => string
    ): Promise<{ sent: boolean; message?: QueuedMessage }> => {
      const { messageQueues, removeQueuedMessage } = useStore.getState();
      const next = messageQueues[srcId]?.[0];
      if (!next || !target?.ptyId) return { sent: false };
      const now = Date.now();
      const quietMs = ptyQuietMs(target.ptyId, now);
      // Cheap pre-check before the control-snapshot IPC; deliveryBlocker repeats it.
      if (!canDeliverToAgent(target.status, quietMs, QUIESCE_IDLE_MS)) return { sent: false };
      const control = await window.cth.controlSnapshot(target.id);
      const ptyId = target.ptyId;
      // The ordered gate (queueDelivery.ts): deliverable → not paused (the one gate
      // "send now" releases) → boot over → user does not own the prompt → cooldown.
      // A draft or an open menu holds delivery; both blocks expire after half an
      // hour, and then we type after whatever is there — automation never erases
      // the user's text and never closes the user's menu.
      const blocked = deliveryBlocker({
        now,
        status: target.status,
        ptyQuietMs: quietMs,
        quiesceMs: QUIESCE_IDLE_MS,
        autoDeliveryPaused: !!control?.autoDeliveryPaused,
        manual: !!next.manual,
        bootGraceUntil: bootGraceUntil.current[target.id] ?? 0,
        terminalSafe: () => isTerminalAutomationSafe(ptyId, now),
        lastFlushAt: lastFlush.current[target.id] ?? 0,
        cooldownMs: FLUSH_COOLDOWN_MS
      });
      if (blocked) return { sent: false };
      // Last gate before we type: re-check the message's delivery-time
      // precondition. A queue item is decided at enqueue time and delivered an
      // arbitrary interval later, and the inbox nudge is only worth sending if
      // there is still something in the inbox — the agent routinely drains it in
      // the very turn the nudge was queued from. Stale ones are DROPPED, not
      // deferred, so they cannot park at the queue head and starve the rest.
      if (await checkPrecondition(next, () => window.cth.hiveInbox(srcId)) === 'drop') {
        removeQueuedMessage(srcId, next.id);
        return { sent: false };
      }
      const flightKey = `${srcId}:${next.id}`;
      if (inFlight.has(flightKey)) return { sent: false };
      inFlight.add(flightKey);
      lastFlush.current[target.id] = now;
      try {
        const sent = await deliverWithAcknowledgement(
          // `instruction` (when present) is the authoritative text to type into
          // the PTY; UI/card surfaces continue to show the readable `text`.
          () => submitToPty(
            target.ptyId!,
            withStandingGoal(
              target,
              wrap ? wrap(next) : (next.instruction ?? next.text)
            ),
            inferAgentProvider(target.command, target.provider)
          ),
          () => {
            removeQueuedMessage(srcId, next.id);
            // Zero the gauge on a DELIVERED /clear — the new session's context
            // isn't known until statusLine fires after the first post-clear
            // response, so leaving it at the old value shows a stale-full bar.
            if (next.text.trim().toLowerCase() === '/clear') {
              useStore.getState().updateAgent(target.id, {
                contextTokens: 0,
                contextLimit: undefined,
                progress: 0
              });
            }
          }
        );
        if (sent) {
          delete sendFailures[next.id];
          return { sent: true, message: next };
        }
        // Failed write (dead/crashed pty the store still thinks is idle): retry
        // on the next cooldown-spaced flush, but only MAX_SEND_ATTEMPTS times —
        // then drop LOUDLY so the loss is diagnosable. (#113/#36)
        const { verdict, attempts } = noteSendFailure(sendFailures, next.id, MAX_SEND_ATTEMPTS);
        if (verdict === 'drop') {
          removeQueuedMessage(srcId, next.id);
          console.warn(
            `[queue-drain] dropping message ${next.id} for ${target.id} after ${attempts} failed pty writes ` +
            `("${next.text.slice(0, 80)}${next.text.length > 80 ? '…' : ''}")`
          );
        }
        return { sent: false };
      } finally {
        inFlight.delete(flightKey);
      }
    };

    // Promote a genuine Slack-origin work item to a stamped kanban card the first
    // time it's dispatched to the office. The card carries slack:{channel,thread_ts}
    // (origin thread) so the main-process done-observer can post its one summary
    // reply in-thread once the card later reaches 'done'. ADDITIVE + idempotent +
    // best-effort: a failure here never affects the dispatch that already happened,
    // and only dispatched work items land here (slash commands/acks never do).
    type SlackTaskCard = Parameters<typeof window.cth.hiveAddTask>[0];
    const ensureSlackCard = async (m: QueuedMessage): Promise<void> => {
      const slack = m.slack;
      if (!slack) return;
      try {
        const raw = await window.cth.hiveTasks();
        const existing: SlackTaskCard[] =
          raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
            ? (raw as { tasks: SlackTaskCard[] }).tasks
            : [];
        const id = `slack-${slack.thread_ts}-${m.id}`;
        if (existing.some((t) => t.id === id)) return; // already promoted — no dup
        const title = m.text.length > 80 ? `${m.text.slice(0, 79)}…` : m.text;
        const card: SlackTaskCard = {
          id,
          title,
          description: m.text,
          status: 'todo',
          dependsOn: [],
          priority: 1,
          createdAt: new Date().toISOString(),
          slack
        };
        await window.cth.hiveAddTask(card);
      } catch { /* best-effort: card promotion must never sink dispatch */ }
    };

    const flush = () => {
      const { agents, messageQueues } = useStore.getState();
      const byId = (id: string) => agents.find((a) => a.id === id);
      const now = Date.now();

      for (const a of agents) {
        // Same gate as dispatch() — this pre-filter runs first, so relaxing only
        // the one inside dispatch would have changed nothing.
        if (!a.ptyId || !canDeliverToAgent(a.status, ptyQuietMs(a.ptyId, now), QUIESCE_IDLE_MS)) continue;
        if (!messageQueues[a.id]?.length) continue;
                void dispatch(a.id, a).then(({ sent, message }) => {
          if (sent && message?.slack) void ensureSlackCard(message);
          // Write the compact latch only once delivery genuinely happened — see
          // the comment in fire() above.
          if (sent && message?.compactUsed !== undefined) {
            lastCompactUsed.current[a.id] = message.compactUsed;
          }
        });
      }
    };

    // Run on every store change (status flips, new queue items) — debounced so a
    // burst of pty-stream updates coalesces — plus a periodic backstop.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; flush(); }, 200);
    };
    const unsub = useStore.subscribe(schedule);
    const iv = setInterval(flush, 3000);
    schedule();
    return () => { unsub(); if (debounce) clearTimeout(debounce); clearInterval(iv); };
  }, [config?.onboardingComplete]);
}
