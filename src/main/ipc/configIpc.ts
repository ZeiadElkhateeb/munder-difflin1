/**
 * Config IPC: read/update harness config (bootstraps hive services on the first
 * harnessHome), token caps, and harness-home validation.
 */
import { ipcMain } from './typedIpc';
import { readConfig, writeConfig, setAgentTokenCap, ensureHarnessHome, type HarnessConfig } from '../config';
import { analytics } from '../analytics';
import { bootstrapHiveServices } from '../lifecycle';
import { hive } from '../services';


/** Registers this module's IPC handlers and load-time wiring. Called once from index.ts. */
export function registerConfigIpc(): void {
  // ─── IPC: config ────────────────────────────────────────────────────────────
  ipcMain.handle('config:get', (): HarnessConfig => readConfig());
  ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => {
    // FIRST RUN: every hive-bound service is started by bootstrapHiveServices(),
    // which runs once at app-ready and early-returns on `!hive.enabled()` — i.e.
    // whenever harnessHome is still null, which is exactly the state a fresh
    // install boots in. Onboarding then sets harnessHome through THIS handler and
    // nothing re-bootstrapped, so the hook server, message router, telemetry
    // collector and mission scheduler all stayed dead for the rest of the session.
    //
    // Symptom: agents spawn and run (the PTY is not hive-bound), but no hook ever
    // reaches the app — no `hooks.sock` on disk, so no SessionStart, which means
    // recordSession() is never called and "Restart & Continue" fails with "No
    // recorded session ID"; the cards also sit on "ctx no status tick yet" and 0
    // tool calls. Everything healed on the next app launch, which is what hid it.
    //
    // changeHome() has always handled this by relaunching; onboarding does not
    // relaunch, so bootstrap here on the null → set transition. Gated on the
    // transition so ordinary config writes never re-enter it.
    const hiveWasEnabled = hive.enabled();
    const wasOnboarded = readConfig().onboardingComplete;
    const next = writeConfig(patch);
    // Live opt-in/out from Settings → Privacy (TELEMETRY.md).
    if (typeof patch?.telemetryEnabled === 'boolean') analytics.setEnabled(patch.telemetryEnabled);
    // Activation funnel (v0.4.6): onboarding just finished (false → true) — the top of
    // the launch → first-agent funnel. `provider` is the engine chosen in the wizard.
    // Fired here (main), not in the renderer, so it rides the same allowlist as the rest.
    if (!wasOnboarded && next.onboardingComplete) {
      analytics.track('onboarding_completed', { provider: next.godProvider ?? 'claude' });
    }
    // Keep the hive's mirror of the spawn gate current. The queue itself reads
    // config per tick so it gates immediately; this is for the PROMPT, which is
    // built per spawn, so flipping the toggle reaches god the next time he starts.
    if (typeof patch?.orchestratorMaySpawn === 'boolean') hive.setOrchestratorMaySpawn(patch.orchestratorMaySpawn);
    if (!hiveWasEnabled && hive.enabled()) {
      console.log('[hive] harnessHome configured — bootstrapping hive services');
      try { bootstrapHiveServices(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
    }
    return next;
  });
  ipcMain.handle('config:setAgentTokenCap', (_evt, agentId: unknown, tokenCap: unknown) =>
    setAgentTokenCap(agentId, tokenCap)
  );
  ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
    return ensureHarnessHome(path);
  });
}
