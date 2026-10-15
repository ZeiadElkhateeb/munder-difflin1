/**
 * The hive's data shapes: messages, tasks, the agent registry, spawn injection.
 */
import type { AgentProvider } from '../../shared/agentProvider';

/** The subset of HarnessConfig the hive consumes for the default-MCP merge.
 *  Kept as a local shape so hive.ts never imports the foundation-owned config
 *  module just for a type. */
export type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

/** What `settleInbox` did to a released worker's mailbox. */
export interface SettledInbox {
  /** Unread messages filed under inbox/.done. */
  moved: number;
  /** Unread messages left pending because they arrived after the cut-off. */
  kept: number;
  /** The filed messages that asked for something — their sender never gets
   *  an answer, and deserves to hear so instead of waiting on a dead worker.
   *  `conversation` lets the caller tell the worker's own work order (which
   *  it just completed) from a genuinely unanswered request. */
  unanswered: Array<{ id: string; act: MessageAct; from: string; subject: string; conversation: string }>;
}

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One hive message reshaped for the voice read-layer (`hive:messages`): the
 *  operator-briefing view of an inbox/outbox message. `subject` and `body` are
 *  REDACTED main-side (see {@link redactSecrets}) before this ever leaves the
 *  main process — the renderer/voice layer never sees a raw body, and never a
 *  secret. PII-free + secret-free by construction. */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** REDACTED subject line. */
  subject: string;
  /** REDACTED message body. */
  body: string;
  requires_reply: boolean;
  /** Which mailbox folder this copy was read from, relative to `owner`. */
  direction: 'inbox' | 'outbox';
  /** The agent whose mailbox this copy lives in. */
  owner: string;
  /** True when read from an archived/handled subfolder (inbox/.done, outbox/.sent). */
  archived: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
}

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** The human has this agent 1:1 and Michael must leave it alone until they
   *  flip it back. Held agents stay ACTIVE and keep their terminal — this is
   *  "do not dispatch to them", not "they are gone", which is why it is its own
   *  flag rather than a reuse of `archived` or a breaker level. */
  onHold?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
  /** Whether `cwd` is actually usable for a (re)spawn — i.e. an ABSOLUTE path
   *  that exists as a directory. Computed + persisted at spawn so the roster
   *  reliably exposes each worker's environment validity. A non-absolute fragment
   *  (e.g. "ClaudeTerminalHarness") spawns into a nonexistent dir and fails; this
   *  flag makes that visible instead of letting it slip through silently. */
  cwdValid?: boolean;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** The hive-protocol seed to TYPE into the TUI after boot rather than pass on
   *  argv — set only for `seedDelivery:'type-into-tui'` providers (Crush), whose
   *  bare TUI rejects a positional seed. The renderer types it through the same
   *  per-pty write-chain as the inbox-wake nudge. (ondev-b) */
  seedPrompt?: string;
  /** Set when the agent spawned in a DEGRADED posture the user should know about
   *  (today: the proxy-bridge sidecar never bound after retries, so a proxy-tier
   *  agent such as Crush runs without hive events). Human-readable, one line. */
  degraded?: string;
}
