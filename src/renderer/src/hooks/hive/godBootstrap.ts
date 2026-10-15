/**
 * Effects 0–1: heal roster captions from hive roles, and bootstrap the god agent
 * (Michael) into his room when no live PTY is running it.
 */
import { useEffect } from 'react';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, tokenizeCommand, type HarnessConfig } from '@/store/config';
import { remoteControlCommandForProvider } from '../../../../shared/providerAutomation';
import { isDurableRole, preferredAgentRole } from '../../../../shared/agentRole';
import { resolveGodName } from '../../../../shared/godIdentity';
import { GOD_ID, GOD_PTY, REMOTE_CONTROL_SETTLE_MS, BOOT_GRACE_MS, INITIAL_GOD_PROMPT, submitToPty } from './shared';
import type { HiveContext } from './context';

export function useGodBootstrap(config: HarnessConfig | null, ctx: HiveContext): void {
  const { godSpawning, bootGraceUntil } = ctx;

  // 0) Heal roster `description` from hive `role` when the floor caption was
  //    overwritten by a status string ("on standby") after hire.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    void window.cth.hiveRegistry().then((reg) => {
      const roles: Record<string, string> = {};
      for (const [id, entry] of Object.entries(reg.agents ?? {})) {
        if (typeof entry.role === 'string' && entry.role.trim()) roles[id] = entry.role.trim();
      }
      useStore.getState().syncDescriptionsFromRoles(roles);
      const { agents, archivedAgents } = useStore.getState();
      for (const a of [...agents, ...archivedAgents]) {
        const next = preferredAgentRole(a.description, roles[a.id], !!a.isGod);
        if (isDurableRole(next) && next !== roles[a.id]) {
          void window.cth.hivePatchAgentRole(a.id, next);
        }
      }
    }).catch(() => { /* hive not ready yet */ });
  }, [config?.onboardingComplete]);
  // 1) Bootstrap the god agent (source of truth = live PTYs, to dodge restarts).
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    let cancelled = false;
    useStore.getState().setGodStatus('booting');
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === GOD_PTY)) { // already running — keep restored entry
        if (!cancelled) useStore.getState().setGodStatus('ready');
        return;
      }
      // Synchronous guard (no await between check and set) → exactly one spawn.
      if (cancelled || godSpawning.current) return;
      godSpawning.current = true;
      useStore.getState().removeAgent(GOD_ID); // clear any stale restored entry

      // A prior rename (Edit Agent panel → renameAgent() → hive.ts's renameAgent())
      // persists straight into registry.json, so read it back here rather than
      // hardcoding DEFAULT_GOD_NAME below — otherwise a custom name reverts on
      // every respawn even though the registry still has it right.
      const reg = await window.cth.hiveRegistry().catch(() => null);
      const godName = resolveGodName(reg?.agents?.[GOD_ID]?.name);

      const godProvider = config.godProvider ?? 'claude';
      const godModel = config.godModel;
      const command = buildSpawnCommand(config, godModel, godProvider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: godProvider,
        args,
        cols: 100,
        rows: 30,
        // Restore Michael's prior conversation across an app restart. His session
        // id lives in the hive registry (recorded from his hooks), so the main
        // process attaches `--resume <id>`; a missing transcript falls back to a
        // fresh session. Without this the most important context on the floor —
        // the orchestrator's — was lost on every restart.
        resume: true,
        hive: { id: GOD_ID, name: godName, provider: godProvider, cwd: config.harnessHome!, isGod: true, role: 'orchestrator (god)' }
      });
      if (cancelled) { godSpawning.current = false; return; }
      if (!res.ok) { godSpawning.current = false; useStore.getState().setGodStatus('failed'); return; }
      const god: Agent = {
        id: GOD_ID,
        name: godName,
        character: 'michael',
        accent: 'lemon',
        description: 'god — runs the floor, triages requests, escalates only critical calls to you',
        project: 'hive',
        tmuxTarget: '',
        cwd: config.harnessHome!,
        status: 'idle',
        action: 'running the floor',
        progress: 0,
        currentStation: 'desk',
        ptyId: GOD_PTY,
        command: command.trim(),
        provider: godProvider,
        model: godModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Kick Michael off once his TUI is up. Always re-enable remote control so
      // the human can approve permission prompts from their phone (best-effort — a
      // failed/unknown slash command just prints to his terminal and is harmless).
      // Then, ONLY on a genuinely fresh spawn, hand him the orientation prompt —
      // a RESUMED Michael already has his full context and must not be re-oriented
      // mid-thread (that would reset the floor's situational awareness). Both go
      // through the per-pty submit chain, so they're strictly sequential and can't
      // jam together; the boot-grace window keeps the inbox-wake/drain loops off
      // Michael until he's settled. The live-PTY branch above skips this entirely.
      const resumedGod = res.resumed === true;
      bootGraceUntil.current[GOD_ID] = Date.now() + BOOT_GRACE_MS;
      void (async () => {
        try {
          const remoteCommand = remoteControlCommandForProvider(godProvider, godName);
          if (remoteCommand) {
            // settleMs pauses the chain ~1.5s after /remote-control before the
            // orientation prompt (fresh spawns only) is submitted next.
            await submitToPty(GOD_PTY, remoteCommand, godProvider, REMOTE_CONTROL_SETTLE_MS);
          }
          if (!cancelled && !resumedGod) {
            // A type-into-tui god (Crush) can't ride its hive protocol on argv, so the
            // main process hands it back as seedPrompt — type it FIRST (identity), then
            // the orientation kick. Serialized via writeChains so they can't jam. (ondev-b)
            if (res.seedPrompt) await submitToPty(GOD_PTY, res.seedPrompt, godProvider);
            await submitToPty(GOD_PTY, INITIAL_GOD_PROMPT, godProvider);
          }
        } catch { /* PTY may have died during startup */ }
        finally { bootGraceUntil.current[GOD_ID] = 0; }
      })();
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config?.onboardingComplete, config?.harnessHome]);
}
