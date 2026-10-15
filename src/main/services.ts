/**
 * The main process's long-lived singletons (PTY manager, hive, hook server, telemetry,
 * breaker, memory, persistence, …), constructed once at load. Everything else imports
 * them from here; nothing in this module may run work at import time beyond construction.
 */
import { PtyManager } from './pty';
import { readConfig } from './config';
import { HiveManager } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker } from './breaker';
import { CumulativeSampleGate, type UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { KnowledgeManager } from './knowledge';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { TelemetryCollector } from './telemetry';
import { IntegrationBroker } from './integrationBroker';
import * as integrations from './integrations';
import { RosterStore } from './roster';
import { ControlRegistry } from './control';
import { WorkerWakeWatchdog } from './workerWake';
import { liveWebContents } from './windows';

export const ptyManager = new PtyManager();
export const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  }
);
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
export const control = new ControlRegistry();
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
export const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
  // D11: scopes the transcript fallback to this agent's own session instead of
  // summing every transcript in a (routinely shared) cwd.
  resolveSessionId: (agentId) => hive.lastSession(agentId)
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
export const usageProvider: UsageProvider = telemetry;
// Grok agents are costed from a cumulative file snapshot (telemetry.ts
// `grokFallback`), so an idle one re-reads identical totals every beat. Their
// session id is real, so the liveness gate below cannot filter that — this
// does, by admitting a row only when the numbers move. Claude's live OTel path
// does not consult it.
export const grokLedgerGate = new CumulativeSampleGate();
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
export const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// Shared roster on disk — created early so HookServer can re-read standing goals
// on every UserPromptSubmit (Edit Agent saves land here via persistAgents).
export const roster = new RosterStore(() => readConfig().harnessHome);
function standingGoalFromRoster(agentId: string): string | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as { id?: unknown; goal?: unknown };
    if (a.id !== agentId) continue;
    return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}
// Worker inbox-wake watchdog (#151): finds idle workers with undrained inbox mail
// and types the same guarded nudge the renderer would have (so a throttled
// background window can't leave a worker parked on an unread inbox forever).
// HookServer feeds it the hook stream so a permission/HITL prompt blocks nudges.
export const workerWake = new WorkerWakeWatchdog();
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
export const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  control,
  breaker,
  standingGoalFromRoster,
  (agentId, event, message) => workerWake.noteHook(agentId, event, message)
);
export const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
// Enterprise Knowledge Graph — file-backed store + agent CLI (default OFF).
export const knowledge = new KnowledgeManager();
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
export const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
export const persist = new PersistStore();

/** The loopback secret broker (Phase 2). Workers reach registered integrations through
 *  it without ever seeing a credential. getRecord/getSecret are injected so the broker
 *  stays electron-free + unit-testable. Started in bootstrapHiveServices; each worker is
 *  granted a per-worker capability token at spawn (revoked in teardownPty). */
export const integrationBroker = new IntegrationBroker({
  getRecord: integrations.getRecord,
  getSecret: integrations.getSecret
});
