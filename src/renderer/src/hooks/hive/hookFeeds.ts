/**
 * Effects 2–2d: drive avatars from real hook events, consume circuit-breaker state, and
 * keep each agent's context gauge current (transcript backfill + status-line push).
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { stationForTool } from './shared';
import type { HiveContext } from './context';

export function useHookFeeds(config: HarnessConfig | null, ctx: HiveContext): void {
  const { breakerLevel } = ctx;

  // 2) Drive avatars from real hook events emitted by each agent's shim.
  useEffect(() => {
    return window.cth.onHiveHookEvent((e) => {
      if (!e.agentId) return;
      const { updateAgent, agents } = useStore.getState();
      const self = agents.find((a) => a.id === e.agentId);
      if (!self) return;
      // Breaker precedence (#5C): a constrained/stopped agent stays 'looping'
      // regardless of in-flight tool/prompt/compact events.
      const blevel = breakerLevel.current[e.agentId];
      const breakerArmed = blevel === 'constrained' || blevel === 'stopped';
      // Hook events are the authoritative status source for real agents (the
      // pty-stream parser only refines the on-floor action/station).
      if (e.event === 'PreCompact') {
        // #5C — agent entered /compact; show it's boxing up context, not frozen.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'compacting', action: 'compacting context', carrying: undefined });
      } else if (e.event === 'PostCompact') {
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'resumed', carrying: undefined });
      } else if (e.event === 'PreToolUse' && e.tool) {
        const m = stationForTool(e.tool);
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action: `using ${e.tool}` });
        useStore.getState().bumpToolCount(e.agentId); // usage proxy for the command center
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // A turn is in progress (prompt submitted / tool just finished) — keep
        // it working so it doesn't flicker idle between tool calls.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working' });
      } else if (e.event === 'PreInvocation') {
        // Antigravity (agy): the model is being called — it's thinking/working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'thinking' });
      } else if (e.event === 'PostInvocation') {
        // agy's per-turn boundary. Unlike Claude, agy's Stop fires only on process
        // EXIT, so without this an agy worker would never register as idle and the
        // inbox-wake nudge (idle-only) could never reach it — its mail would sit
        // undrained. Treat it as idle; a follow-up tool/turn re-sets working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // A blocked Stop means the agent is being re-engaged to process its
        // inbox — it's NOT idle, so keep it working until it genuinely stops.
        if (e.blocked) {
          if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'reading inbox', carrying: undefined });
        } else {
          // A genuine stop clears any breaker override — the run is over.
          breakerLevel.current[e.agentId] = 'healthy';
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      } else if (e.event === 'Notification' && !breakerArmed) {
        // Claude Code fires Notification for two very different situations:
        //   1. it genuinely needs the human (a permission / approval prompt), or
        //   2. the prompt has merely gone idle ("Claude is waiting for your
        //      input") — i.e. the agent answered and has nothing queued.
        // Only (1) is a real "needs you". Treating (2) as blocked made Michael
        // march to the door with a red "!" right after finishing, so detect the
        // idle case and let him linger on the floor instead.
        const msg = (e.message ?? '').toLowerCase();
        const idleWaiting = !msg
          || msg.includes('waiting for your input')
          || msg.includes('is idle')
          || msg.includes('waiting for input');
        const needsHuman = msg.includes('permission')
          || msg.includes('approve')
          || msg.includes('confirm')
          || msg.includes('needs your');
        if (needsHuman && !idleWaiting) {
          // Only the god agent escalates to the human; sub-agents are autonomous
          // and read as "waiting" (parked on god, not on you).
          updateAgent(e.agentId, { status: self.isGod ? 'blocked' : 'waiting' });
        } else {
          // Idle notification — responded, nothing to do. Linger, don't flag.
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    });
  }, []);
  // 2b) Consume circuit-breaker state (#7C.4/#5C). Lane A's breaker policy (#6)
  //     pushes BreakerState on `control:breakerState`; this gives it PRECEDENCE
  //     over hook-derived status: a constrained/stopped agent is pinned to
  //     'looping' (see the breakerArmed guard above) until it genuinely Stops.
  useEffect(() => {
    return window.cth.onBreakerState((s) => {
      breakerLevel.current[s.agentId] = s.level;
      const { updateAgent, agents } = useStore.getState();
      if (!agents.some((a) => a.id === s.agentId)) return;
      if (s.level === 'constrained' || s.level === 'stopped') {
        updateAgent(s.agentId, { status: 'looping', action: s.reason || 'breaker armed', carrying: undefined });
      }
      // 'healthy'/'steering' clear the pin; the next hook event refreshes status.
    });
  }, []);
  // 2c) Context gauge backfill: poll each live agent's current context size
  //     (tokens) from its session transcript — only until the status line
  //     (effect 2d) has delivered exact numbers for that agent.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const poll = async () => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // The status line pushes exact numbers after every response (effect
        // 2d) — this transcript poll only backfills agents whose status line
        // hasn't fired yet (e.g. freshly restored, no response so far).
        if (a.contextLimit !== undefined) continue;
        try {
          const ctx = await window.cth.agentContext(a.id);
          if (ctx === null) continue;
          const hinted = /1m/i.test(a.model ?? '') ? 1_000_000 : 200_000;
          const limit = Math.max(hinted, ctx > 200_000 ? 1_000_000 : 0);
          const progress = Math.max(0, Math.min(8, Math.round((ctx / limit) * 8)));
          updateAgent(a.id, { contextTokens: ctx, progress });
        } catch { /* ignore — try again next tick */ }
      }
    };
    const t = setTimeout(poll, 3000); // first fill shortly after boot
    const iv = setInterval(poll, 15000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [config?.onboardingComplete]);
  // 2d) Push-based context gauge: the status-line shim forwards the session's
  //     EXACT context accounting (tokens + real window size) after every
  //     response — no probing, no transcript guesswork.
  useEffect(() => {
    return window.cth.onHiveContextUpdate(({ agentId, tokens, limit }) => {
      // Defense-in-depth: the main process already filters limit > 0, but the
      // renderer must not trust IPC blindly — limit 0 would put NaN progress
      // into the store (NaN survives the Math.min/max clamp).
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(tokens)) return;
      const progress = Math.max(0, Math.min(8, Math.round((tokens / limit) * 8)));
      useStore.getState().updateAgent(agentId, { contextTokens: tokens, contextLimit: limit, progress });
    });
  }, []);
}
