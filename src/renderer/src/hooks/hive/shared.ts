/**
 * Constants and helpers shared by the useHive effect hooks: god identity, timing
 * windows, the PTY write path (submitToPty), standing goals, prompt builders, and
 * tool → station mapping for the floor.
 */
import type { Agent, StationKind, ToolKind } from '@/store/store';
import { inferAgentProvider } from '@/store/config';
import { terminalReadyToReceive } from '../../../../shared/providerAutomation';
import type { ContextRule } from '../../../../shared/triggers';
import { type AgentProvider, bridgeOf, providerPreset } from '../../../../shared/agentProvider';

export const GOD_ID = 'god';

/** Accent palette for MAIN-spawned (voice-hired) agents — picked deterministically
 *  from the agent id so the same agent always gets the same colour. Mirrors the
 *  AddAgentModal palette. */
export const SPAWN_ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;

export const GOD_PTY = `pty-${GOD_ID}`;

export const REMOTE_CONTROL_SETTLE_MS = 1500;

// Provider-agnostic PTY-quiescence idle fallback (#2e). A non-Claude bridge that
// fires a 'working' event but never its turn-end signal (Stop / session.idle /
// agent_end) would pin the agent 'working' forever → the idle-only inbox-wake nudge
// never fires → a god stops draining mail and the floor stalls. So a 'working'
// agent whose PTY has emitted NOTHING for this window is treated as turn-done and
// flipped idle. A streaming turn (incl. a long tool) keeps emitting bytes → stays
// working; only true silence drifts it idle. Hook events still win — a fresh
// PreToolUse/Stop refreshes status on the next event. Checked on QUIESCE_POLL_MS.
export const QUIESCE_IDLE_MS = 12000;

export const QUIESCE_POLL_MS = 4000;

// After a god/agent spawn, hold off the inbox-wake + queue-drain typers for this
// long while the readiness handshake + provider-specific boot sequence runs.
export const BOOT_GRACE_MS = 35_000;

// Delay before typing a one-time TUI protocol seed into a fresh worker (3b) —
// long enough for the TUI to finish painting and surface any permission prompt.
// submitToPty additionally waits for the terminal's readiness handshake.
export const SEED_BOOT_MS = 12_000;

/** Hive-aware / hooks-bridge engines get standing goals via HookServer
 *  (SessionStart + UserPromptSubmit). Cursor and other no-hook engines need the
 *  goal prepended onto queued PTY deliveries so an Edit Agent save still lands
 *  on the next drain cycle without a restart. */
export function usesHookStandingGoal(agent: Agent): boolean {
  const provider = inferAgentProvider(agent.command, agent.provider);
  const preset = providerPreset(provider);
  if (preset.hiveAware) return true;
  return bridgeOf(provider)?.kind === 'hooks';
}

/** Prepend `<goal>…</goal>` for engines that cannot inject via hooks. Reads the
 *  live store field, so a just-saved goal is picked up on the next queue flush. */
export function withStandingGoal(agent: Agent, text: string): string {
  const goal = agent.goal?.trim();
  if (!goal || usesHookStandingGoal(agent)) return text;
  if (text.includes('<goal>')) return text;
  return `<goal>\n${goal}\n</goal>\n\n${text}`;
}

// The first thing Michael (god) is told on a fresh spawn — orient him and put
// him to work running the floor. Kept terse and action-oriented.
export const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of the hive. Get oriented, then start running the floor:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md + tasks.json and the current roster of agents (active vs archived).',
  '3. Check fleet health: read fleet.json in the hive root for every agent\'s live tokens, cost, status, breaker level, and inbox backlog (`claude agents` will NOT show your hive\'s agents). Flag anyone stalled, over-budget, or breaker-armed.',
  '4. Skim COMMANDS.md (hive root) for the Claude Code commands you can use — and run `mempalace wake-up` for a memory digest if the CLI is available.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

// Per-pty submission chain. Every submitToPty for a given pty is appended here so
// two callers (e.g. the boot sequence's /remote-control and the inbox-wake nudge)
// can NEVER interleave their text + Enter — which jammed them onto one line and
// produced "Unknown command: /remote-control<next prompt>".
export const writeChains = new Map<string, Promise<void>>();

export const readyPids = new Map<string, number>();

export async function waitForTerminalReady(
  ptyId: string,
  provider: AgentProvider,
  timeoutMs = 30_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const live = await window.cth.listPtys();
    const pty = live.find((entry) => entry.id === ptyId);
    if (!pty) throw new Error(`PTY exited before becoming ready: ${ptyId}`);
    if (readyPids.get(ptyId) === pty.pid) return;
    if (terminalReadyToReceive(pty.hasOutput, Date.now() - started, provider)) {
      readyPids.set(ptyId, pty.pid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`PTY did not become ready within ${timeoutMs}ms: ${ptyId}`);
}

/**
 * Type a line into an agent's Claude Code TUI and actually submit it.
 *
 * Writing the text and the carriage return in a single chunk makes the TUI
 * treat the whole thing as a paste, so the "\r" lands as a newline inside the
 * input box instead of submitting — the command just sits there as text. We
 * send the text first, then the Enter as a separate keystroke a tick later so
 * the prompt is registered and executed. Idle autonomous agents thus act on a
 * dispatched instruction on their own.
 *
 * Submissions to the same pty are serialized (and each settles for `settleMs`
 * after Enter) so concurrent callers can't jam their input together.
 *
 * The text is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) so the
 * TUI treats it as ONE paste: embedded newlines land as literal newlines in the
 * input box. Without them, every "\n" in a multi-line message acted as Enter —
 * the message submitted line-by-line in fragments (the agent saw only the last
 * chunk). The closing Enter, sent a tick later, submits the whole block. (#24) */
export function submitToPty(
  ptyId: string,
  text: string,
  provider: AgentProvider,
  settleMs = 250
): Promise<void> {
  const prev = writeChains.get(ptyId) ?? Promise.resolve();
  const next = prev.catch(() => { /* a failed prior write must not stall the chain */ }).then(async () => {
    await waitForTerminalReady(ptyId, provider);
    // Bracketed paste (ESC[200~ … ESC[201~) only matters for MULTI-LINE text, so a
    // stray "\n" doesn't submit early (#24). Single-line text (nudges, slash
    // commands) is sent raw — some TUIs (Antigravity's agy) treat the paste
    // markers as literal input and never submit, so skipping them is more robust.
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    // writePty NEVER rejects for a dead pty — it resolves { ok:false, error:
    // 'no pty: …' } — so an unchecked await here made every failed delivery look
    // successful (the queue-drain then destroyed the message it had already
    // popped, #36). Surface the failure as a rejection; the chain itself is
    // immune (the prev.catch above absorbs it for the next writer).
    const wrote = await window.cth.writePty(ptyId, payload);
    if (!wrote?.ok) throw new Error(wrote?.error ?? `pty write failed: ${ptyId}`);
    await new Promise((r) => setTimeout(r, 140));
    const submitted = await window.cth.writePty(ptyId, '\r');
    if (!submitted?.ok) throw new Error(submitted?.error ?? `pty write failed: ${ptyId}`);
    await new Promise((r) => setTimeout(r, settleMs));
  });
  writeChains.set(ptyId, next);
  return next;
}

/** Wrap a user message as an enrich task for the assistant. The assistant's
 *  system prompt has the full instructions; this just frames the one task. */
export function enrichTaskPrompt(text: string): string {
  return [
    `ENRICH TASK: ${text}`,
    '',
    '(Identify the relevant project, cd in, gather READ-ONLY context, then send the improved,',
    'self-contained prompt to Michael via an outbox message with "to":"god". Do not do the task yourself.)'
  ].join('\n');
}

export function terminalWorkOrderPrompt(msg: {
  id: string;
  from: string;
  act: string;
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}): string {
  return [
    'WORK ORDER FROM HIVE',
    `Message: ${msg.id}`,
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    `Act: ${msg.act}${msg.requiresReply ? ' (reply expected)' : ''}`,
    `Issued: ${msg.createdAt}`,
    '',
    msg.body,
    '',
    'Notes:',
    '- This arrived through your terminal because this provider does not support hive inbox.',
    '- Work in your current cwd.',
    '- When done, report changes, validation, blockers, and next step in this terminal.'
  ].join('\n');
}

/** Tool name → where the avatar walks + what it carries. */
export const TOOL_STATION: Record<string, { station: StationKind; carry?: ToolKind }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' },
  Write: { station: 'desk', carry: 'Write' },
  Bash: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' },
  Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' },
  WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' },
  // #5A — delegating to a sub-agent reads as "handing off at the outbox".
  Task: { station: 'mailbox', carry: 'TodoWrite' }
};

/** Resolve a tool name to its station/glyph. Falls back: any `mcp__*` tool →
 *  the MCP station (previously these silently sat at the desk, #5A gap); anything
 *  else → the desk. */
export function stationForTool(tool: string): { station: StationKind; carry?: ToolKind } {
  if (TOOL_STATION[tool]) return TOOL_STATION[tool];
  if (tool.startsWith('mcp__')) return { station: 'mcp', carry: 'MCP' };
  // Heuristic fallback for non-Claude tool names (Antigravity sends run_command,
  // ListDir, write_file, … — its hook names differ from Claude's exact tags).
  // Match write/edit BEFORE read so "write_file" → desk, not shelf.
  const t = tool.toLowerCase();
  if (/command|bash|shell|exec|terminal|run_/.test(t)) return { station: 'terminal', carry: 'Bash' };
  if (/web|fetch|browser|http|url/.test(t)) return { station: 'web', carry: 'WebFetch' };
  if (/write|edit|create|patch|replace|apply/.test(t)) return { station: 'desk', carry: 'Write' };
  if (/read|list|view|dir|glob|grep|search|find|file|cat|\bls\b/.test(t)) return { station: 'shelf', carry: 'Read' };
  return { station: 'desk' };
}

/** At/above this window size an agent counts as "large context" and is judged
 *  against `minContextPctLargeWindow` instead. Sits between the two real-world
 *  window sizes the app ever sees (200k and 1M) so neither lands ambiguously. */
export const LARGE_CONTEXT_WINDOW = 500_000;

/**
 * How full this agent's context window is, 0-100, or null when we have no
 * reading at all.
 *
 * Two sources feed the store and only one is exact: the status-line shim pushes
 * real `contextTokens` + `contextLimit` (effect 2d), while the transcript poll
 * (2c) backfills tokens ONLY. So an agent can legitimately know its token count
 * without knowing its window — infer the window the same way 2c does rather
 * than throwing the token reading away.
 */
export function contextFillPct(a: Agent): number | null {
  if (a.contextTokens === undefined || !Number.isFinite(a.contextTokens)) return null;
  const limit = a.contextLimit && a.contextLimit > 0
    ? a.contextLimit
    : (/1m/i.test(a.model ?? '') ? 1_000_000 : 200_000);
  return (a.contextTokens / limit) * 100;
}

/**
 * The context-pressure gate: is this agent full enough to be worth interrupting?
 *
 * `minContextPct` of 0 disables the gate (the rule's cadence alone fires it).
 *
 * FAIL-OPEN when we have no reading. That is the deliberate choice: context
 * telemetry arrives over the Claude status-line/hook path, so most non-Claude
 * providers report nothing at all. Failing closed there would silently reinstate
 * the very bug this replaces — a fleet that never compacts — only harder to
 * notice. An unmetered agent therefore falls back to time-only firing, which is
 * exactly the old behaviour and no worse.
 */
export function passesContextPressure(a: Agent, rule: ContextRule): boolean {
  const large = (a.contextLimit ?? 0) >= LARGE_CONTEXT_WINDOW;
  const bar = large ? rule.minContextPctLargeWindow : rule.minContextPct;
  if (!(bar > 0)) return true;
  const pct = contextFillPct(a);
  if (pct === null) return true;
  return pct >= bar;
}
