/**
 * The MD queue (messages parked until an agent's terminal is free), composer drafts,
 * ask-me answer drafts and the dispatch seed. See docs/message-queue.md.
 */
import type { StateCreator } from 'zustand';
import { isCompactionCommand } from '@shared/providerAutomation';
import { isInboxNudge } from '@shared/hiveNudge';
import type { QueuedMessage } from '../types';
import { persistQueues, initialQueues, newQueuedId } from '../persistence';
import type { State } from '../store';

export interface QueueSlice {
  /** Per-agent outgoing message queue (agent id → messages awaiting delivery).
   *  Lets the user keep "talking" to a busy agent: messages park here and are
   *  drained to the terminal one-by-one once the agent is free. */
  messageQueues: Record<string, QueuedMessage[]>;
  /** Unsent composer drafts, per agent — so switching agents (which remounts the
   *  composer) doesn't eat what the user was typing. */
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** Unsent ASK ME answer drafts, keyed by task id — so switching tabs (which
   *  unmounts the ask-me view) doesn't eat a half-typed answer. */
  answerDrafts: Record<string, string>;
  setAnswerDraft: (taskId: string, text: string) => void;
  /** One-shot prefill for the Command Center's dispatch box (a task detail's
   *  "assign" from anywhere in the app). seq-keyed like ccTabRequest. */
  dispatchSeedRequest: { text: string; seq: number } | null;
  requestDispatchSeed: (text: string) => void;
  /** Park a message for an agent. Returns nothing; the flush loop delivers it.
   *  `meta.instruction`, when set, is what gets typed into the PTY instead of
   *  `text` (UI/card surfaces still show `text`). */
    enqueueMessage: (agentId: string, text: string, meta?: { slack?: { channel: string; thread_ts: string }; instruction?: string; precondition?: QueuedMessage['precondition']; compactUsed?: number }) => void;
  /** Drop a single queued message (user removed it, or it was just delivered). */
  removeQueuedMessage: (agentId: string, messageId: string) => void;
  /** "Send now" while floor auto-delivery is paused: marks the message manual
   *  (drain bypasses the pause gate for it) and moves it to the queue front. */
  releaseQueuedMessage: (agentId: string, messageId: string) => void;
  /** Clear an agent's entire pending queue. */
  clearQueue: (agentId: string) => void;
}

export const createQueueSlice: StateCreator<State, [], [], QueueSlice> = (set, get) => ({
  messageQueues: initialQueues,
  dispatchSeedRequest: null,
  requestDispatchSeed: (text) =>
    set((s) => ({ dispatchSeedRequest: { text, seq: (s.dispatchSeedRequest?.seq ?? 0) + 1 } })),
  answerDrafts: {},
  setAnswerDraft: (taskId, text) =>
    set((s) => ({ answerDrafts: { ...s.answerDrafts, [taskId]: text } })),
  drafts: {},
  setDraft: (agentId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [agentId]: text } })),
  enqueueMessage: (agentId, text, meta) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      // ONE PENDING COMPACT PER AGENT. Compaction is idempotent in the worst way:
      // the first `/compact` does the work and every one behind it answers
      // "nothing to compact", so a queue that accumulates them spends a delivery
      // slot and a model round-trip per copy to achieve nothing, and buries the
      // operator's real backlog behind them.
      //
      // The invariant lives HERE rather than at the call sites because there are
      // several — the context trigger, god dispatching a work order, Slack, the
      // composer — and each one that grew its own check could still be bypassed
      // by the next path someone adds. The context trigger's own check stays as
      // cheap defence in depth, but this is the one that cannot be routed around.
      const queued = s.messageQueues[agentId] ?? [];
      if (isCompactionCommand(trimmed) && queued.some((m) => isCompactionCommand(m.text))) {
        return s;
      }
      // ONE PENDING INBOX NUDGE PER AGENT — the same property, for the same
      // reason. The first nudge makes the agent drain its WHOLE inbox, so every
      // nudge queued behind it lands on a directory that agent has already
      // emptied and answers "nothing new": a delivery slot and a model
      // round-trip each, to say nothing. Mail arriving while an agent is mid-turn
      // queues one nudge per poll, so this is the common case rather than the
      // rare one, and the floor reports it as repeated empty-inbox wakes.
      // Suppressing the copy loses nothing — the surviving nudge sends the agent
      // to the same authoritative directory, where the newer mail is waiting too.
      if (isInboxNudge(trimmed) && queued.some((m) => isInboxNudge(m.text))) {
        return s;
      }
            const msg: QueuedMessage = {
        id: newQueuedId(), text: trimmed, ts: Date.now(),
        ...(meta?.slack ? { slack: meta.slack } : {}),
        ...(meta?.instruction ? { instruction: meta.instruction } : {}),
        ...(meta?.precondition ? { precondition: meta.precondition } : {}),
        ...(meta?.compactUsed !== undefined ? { compactUsed: meta.compactUsed } : {})
      };
      const messageQueues = { ...s.messageQueues, [agentId]: [...(s.messageQueues[agentId] ?? []), msg] };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  removeQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      if (!current) return s;
      const next = current.filter((m) => m.id !== messageId);
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  releaseQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      const target = current?.find((m) => m.id === messageId);
      if (!current || !target) return s;
      const next = [
        { ...target, manual: true },
        ...current.filter((m) => m.id !== messageId)
      ];
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  clearQueue: (agentId) =>
    set((s) => {
      if (!s.messageQueues[agentId]?.length) return s;
      const messageQueues = { ...s.messageQueues, [agentId]: [] };
      persistQueues(messageQueues);
      return { messageQueues };
    })
});
