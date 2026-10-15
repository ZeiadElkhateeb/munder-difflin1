/**
 * Effect 7: auto-revive PTYs that wedged across a system sleep / lock.
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';
import { roleForHiveSpawn } from '../../../../shared/agentRole';
import { acquireTerminal, resetTerminal } from '@/components/terminalPool';
import type { HiveContext } from './context';

export function useAutoRevive(config: HarnessConfig | null, ctx: HiveContext): void {
  const { reviving } = ctx;

  // 7) Auto-revive wedged PTYs after the Mac sleeps/locks. Kevin's main-process
  //    keepalive catches up its schedules on wake and DETECTS terminals that were
  //    live before sleep but went silent after resume — it reports those ids on
  //    `power:resume`. We respawn EXACTLY those, resuming each agent's prior CLI
  //    session (--resume) so the terminal self-heals instead of the user clicking
  //    "Restart & Continue". This reuses the same resume-spawn flow as that button
  //    (CommandCenterPanel.restartWithModel) and restoreTeam's worktree handling.
  //    Pure addition: an empty `dead[]` is a no-op; healthy PTYs are never touched.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    // Skip an id we revived (or are mid-reviving) within this window — coalesces
    // a resume + unlock that arrive back-to-back (main also coalesces on its side).
    const REVIVE_DEBOUNCE_MS = 8000;

    const revive = async (deadId: string): Promise<void> => {
      const now = Date.now();
      if (now - (reviving.current[deadId] ?? 0) < REVIVE_DEBOUNCE_MS) return;
      reviving.current[deadId] = now; // claim BEFORE any await so re-entry can't double-spawn
      // Only respawn a PTY we actually own; never touch an unknown/healthy id.
      const a = useStore.getState().agents.find((x) => x.ptyId === deadId);
      if (!a) return;
      try {
        const cfg = await window.cth.getConfig();
        // Isolated agents run inside their worktree (a.cwd is the base repo); re-enter
        // it if it still exists, else fall back to the base cwd — same as restoreTeam.
        let cwd = a.cwd;
        if (a.worktreePath && (await window.cth.gitIsRepo(a.worktreePath))) cwd = a.worktreePath;
        await window.cth.killPty(deadId);
        // Soft-reset the pooled xterm in place (no-op if none): re-arm input and
        // clear the stale frame so the revived TUI paints clean — like the button.
        resetTerminal(deadId);
        const provider = inferAgentProvider(a.command, a.provider);
        // Prefer the agent's exact recorded command (same model/flags); fall back to
        // a rebuilt one only if it predates the persisted `command` field.
        const command = (a.command ?? '').trim() || buildSpawnCommand(cfg, a.model, provider);
        const [exe, ...args] = tokenizeCommand(command);
        const hive = a.isGod
          ? { id: a.id, name: a.name, cwd, provider, isGod: true, role: roleForHiveSpawn(a) }
          : a.isAssistant
          ? { id: a.id, name: a.name, cwd, provider, isAssistant: true, role: roleForHiveSpawn(a) }
          : { id: a.id, name: a.name, cwd, provider, role: roleForHiveSpawn(a) };
        // Spawn at the terminal's real grid so the TUI's absolute cursor moves land
        // in the right cells (a size mismatch scatters the redraw).
        const entry = acquireTerminal(deadId);
        let cols = 100, rows = 30;
        try { entry.fit.fit(); cols = entry.term.cols; rows = entry.term.rows; } catch { /* host not sized yet */ }
        const res = await window.cth.spawnPty({
          id: deadId,
          cwd,
          command: exe,
          provider,
          args,
          cols,
          rows,
          // The worktree (if any) already exists on disk — re-enter it, do NOT
          // re-isolate (that conflicts on the existing path/branch).
          isolate: false,
          // Reattach the agent's prior session so no context is lost on revive.
          resume: true,
          hive
        });
        if (res.ok) {
          reviving.current[deadId] = Date.now(); // re-stamp so the debounce covers the spawn
          useStore.getState().updateAgent(a.id, { status: 'idle', action: 'revived after sleep' });
        } else {
          delete reviving.current[deadId]; // let a later power:resume retry it
          console.error('[autorevive] respawn failed for', a.id, res.error);
        }
      } catch (err) {
        delete reviving.current[deadId];
        console.error('[autorevive] respawn threw for', deadId, err);
      }
    };

    return window.cth.onPowerResume?.((e) => {
      const dead = Array.isArray(e?.dead) ? e.dead : [];
      if (!dead.length) return; // healthy wake — nothing wedged, no-op
      for (const id of dead) void revive(id);
    });
  }, [config?.onboardingComplete]);
}
