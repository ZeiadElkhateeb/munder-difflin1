/**
 * The renderer store's data shapes: agents, feed entries, queued messages, stations.
 */
import type { AccentColorName } from '@/design/tokens';
import type { OfficeCharacterName } from '@/scene/office/cast';
import type { StatusKind } from '@/components/PixelBadge';
import type { AgentProvider } from '@shared/agentProvider';

export type ToolKind =
  | 'Read' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'WebSearch'
  | 'Grep' | 'Glob' | 'TodoWrite' | 'MCP';

export type StationKind =
  | 'shelf' | 'terminal' | 'web' | 'board' | 'mailbox' | 'mcp' | 'desk';

export interface BlockReason {
  summary: string;                 // short headline shown on banner
  detail: string;                  // longer explanation
  command?: string;                // verbatim command awaiting confirmation, if any
  actions: Array<{
    label: string;
    kind: 'approve' | 'deny' | 'neutral';
    /** what we'd send to the tmux pane on click */
    send?: string;
  }>;
}

export interface Agent {
  id: string;
  name: string;
  /** which Office character represents this agent on the floor */
  character: OfficeCharacterName;
  accent: AccentColorName;
  /** persistent job / hire one-liner — same string as hive registry `role`.
   *  Live status belongs on `status` / `action`, never here. */
  description: string;
  project: string;
  /** legacy field — populated only for the seeded mock agents */
  tmuxTarget: string;
  cwd: string;
  goal?: string;
  /** User-authored private note shown and edited from the roster-card hover. */
  note?: string;
  status: StatusKind;
  action: string;
  progress: number;
  currentStation?: StationKind;
  carrying?: ToolKind;
  /** latest assistant message, streamed character-by-character in the sidebar */
  recentAssistantText?: string;
  /** epoch ms — used to drive the typewriter so identical strings still re-stream */
  recentTextTs?: number;
  /** populated when status === 'blocked' */
  blockReason?: BlockReason;
  /** present iff this agent has a real PTY in the main process */
  ptyId?: string;
  /** Incremented by Restart & Continue to remount this agent's xterm without
   * changing its durable PTY/session identity. */
  terminalGeneration?: number;
  /** the command being run in the PTY (e.g. 'claude' or 'agy') */
  command?: string;
  /** which agent CLI preset owns this PTY recipe; drives the model picker +
   *  spawn flags. Defaults to 'claude' when unset (legacy agents / inferred
   *  from command). */
  provider?: AgentProvider;
  /** the model this agent runs on (e.g. 'claude-sonnet-4-6[1m]' or 'gemini-3-pro');
   *  drives the model selector + the --model arg used when (re)spawning the agent */
  model?: string;
  /** the last prompt the user submitted to this agent in Claude Code —
   *  shown on the floor as a card above the seated avatar */
  lastPrompt?: string;
  /** the orchestrator ("god") agent — seated in Michael's room, runs the floor */
  isGod?: boolean;
  /** Michael's prep assistant — send-only; enriches prompts and forwards them to
   *  the god. Excluded from broadcast fan-out and from the restorable-dead sweep. */
  isAssistant?: boolean;
  /** The human has this agent 1:1 and Michael has been told to leave it alone.
   *  Mirrors `RegistryAgent.onHold`; main owns the record, this is the copy the
   *  title bar renders from. */
  onHold?: boolean;
  /** When git isolation is enabled, the dedicated worktree path the agent runs
   *  in (its own `agent/<id>` branch); undefined for shared-cwd agents. */
  worktreePath?: string;
  /** Live context size of the agent's Claude session (tokens), polled from its
   *  transcript. Drives the context gauge on the agent card. */
  contextTokens?: number;
  /** The context-window limit assumed for this agent's model (tokens). */
  contextLimit?: number;
  /** True once this agent's terminal was closed. Archived agents are retained
   *  (in the store's `archivedAgents` list + the hive registry) but flagged and
   *  kept off the floor; only live-PTY agents are 'active'. */
  archived?: boolean;
  /** Hive protocol to TYPE into this agent's TUI as its first turn, set at spawn
   *  for `seedDelivery:'type-into-tui'` providers (Crush) whose bare TUI rejects a
   *  positional seed. useHive types it once after boot-grace then clears it.
   *  Ephemeral spawn state — not persisted. (ondev-b) */
  seedPrompt?: string;
}

export interface FeedEntry {
  agentId: string;
  text: string;
  ts: number;
}

/** A message the user has parked for an agent while its terminal was busy.
 *  Queued messages are drained one at a time when the agent next goes idle (see
 *  useHive's flush loop). */
export interface QueuedMessage {
  id: string;
  text: string;
  /** epoch ms the message was queued — drives ordering and the "queued 2m ago" hint */
  ts: number;
  /** Slack-originated: thread coordinates so the office can reply in-thread. */
  slack?: { channel: string; thread_ts: string };
  /** Optional override for the text actually typed into the agent's PTY. When set,
   *  the drain submits THIS instead of `text`, while UI/card surfaces keep using
   *  `text`. Used by Slack-origin work to carry the autonomy preamble to god's
   *  prompt without polluting the human-readable kanban card title (= raw `text`). */
  instruction?: string;
  /** User clicked "send now" while floor-wide auto-delivery was paused. Bypasses
   *  ONLY the pause gate in the drain loop — idle/draft/picker safety still hold,
   *  so it delivers the moment the terminal is actually free. */
  manual?: boolean;
  /** Delivery-time precondition, re-checked by the drain immediately before the
   *  message is typed; a message whose precondition no longer holds is DROPPED
   *  rather than deferred (deferring would park it at the queue head forever and
   *  starve everything behind it).
   *
   *  Exists because a queued message is evaluated at enqueue time but delivered
   *  an arbitrary interval later, and some messages are only worth sending if the
   *  world they described still exists. 'inbox-nonempty' is the inbox-wake nudge:
   *  the agent can drain its whole inbox in the same turn the nudge was queued
   *  from, and delivering it afterwards costs a full turn to discover nothing is
   *  there. Declarative (a string, not a closure) so it survives persistQueues. */
  precondition?: 'inbox-nonempty';
    /** Token count captured when a /compact was enqueued for this agent, carried
   *  through to the point of successful delivery so the "already compacted at
   *  N tokens" latch (see useHive) can be written there instead of at enqueue
   *  time. Enqueue time is too early: a /compact stuck behind an undeliverable
   *  status would otherwise latch out every future compact attempt for a
   *  compaction that never actually happened. */
  compactUsed?: number;
}

// 'files' retired in v0.3.4 (the per-agent IDE button superseded it) — a
// persisted 'files' selection falls back to 'terminal' on load. 'git' added in
// v0.3.4: at-a-glance branch/status/log without opening the IDE.
export type SidebarTab = 'terminal' | 'messages' | 'traces' | 'git';

/** Lifecycle of the god agent ("Michael") bootstrap on launch.
 *  'booting' until his PTY is confirmed live, then 'ready' (or 'failed' if the
 *  spawn errored). The empty-floor UI shows a loader while 'booting' so users
 *  don't see the "add agent" prompt before Michael has clocked in. */
export type GodStatus = 'booting' | 'ready' | 'failed';
