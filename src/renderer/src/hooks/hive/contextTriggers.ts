/**
 * Effect 6: context triggers — main decides WHEN to compact/clear, this queues it.
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { inferAgentProvider, type HarnessConfig } from '@/store/config';
import { clearCommandForProvider, compactionCommandForProvider } from '../../../../shared/providerAutomation';
import { DEFAULT_CONTEXT_TRIGGER, type ContextRule } from '../../../../shared/triggers';
import { canDeliverToAgent } from '../queueDelivery';
import { QUIESCE_IDLE_MS, passesContextPressure } from './shared';
import type { HiveContext } from './context';

export function useContextTriggers(config: HarnessConfig | null, ctx: HiveContext): void {
  const { lastCompactUsed, ptyQuietMs } = ctx;

  // 6) CONTEXT TRIGGERS (compact / clear). Main decides WHEN — cadence, and which
  //    half of the rule fired — and pushes `{action, rule}`; this decides WHO, then
  //    queues the provider's own command so the drain (#4) delivers it only at an
  //    idle prompt, never jamming a working terminal.
  //
  //    THE PRESSURE GATE. main/config.ts has long DOCUMENTED that auto-compact
  //    "only compacts agents whose context has filled past a threshold (30% for
  //    ~250k windows, 20% for ~1M windows)". No such check was ever implemented:
  //    every live agent with a resolvable command got compacted on every tick,
  //    hourly, however empty its window was. This makes the documented behaviour
  //    real — `rule.minContextPct`, or `minContextPctLargeWindow` once the window
  //    is >= LARGE_CONTEXT_WINDOW, must be met before an agent is interrupted.
  //    (The shipped bars are now 60/40, twice the stale doc's numbers; see
  //    DEFAULT_CONTEXT_TRIGGER. The doc comment in config.ts is still stale.)
  //
  //    Dedupe generalises to both actions: keyed on the command's own verb, so a
  //    queued `/compact` blocks a second compact without blocking a `/clear`.
  useEffect(() => {
    if (!config?.onboardingComplete) return;

       const fire = (action: 'compact' | 'clear', rule: ContextRule): void => {
      const { agents, messageQueues, enqueueMessage } = useStore.getState();
      const now = Date.now();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // Gate #109-2: don't enqueue a context command for an agent that cannot
        // currently receive one (e.g. god 'blocked' on a human prompt). Enqueuing
        // anyway left a stuck /compact at the head of the queue that dedupe then
        // collapsed every subsequent hourly attempt against, forever — the exact
        // same check the drain itself uses immediately before typing, so a
        // command is never queued in a state the drain would refuse to deliver.
        if (!canDeliverToAgent(a.status, ptyQuietMs(a.ptyId, now), QUIESCE_IDLE_MS)) continue;
        const provider = inferAgentProvider(a.command, a.provider);
        const command = action === 'clear'
          ? clearCommandForProvider(provider, rule.message)
          : compactionCommandForProvider(provider, rule.message);
        // No trustworthy command for this CLI (Crush's palette-only TUI, Copilot's
        // print mode, an unknown custom binary) — leave its terminal alone.
        if (!command) continue;
        if (!passesContextPressure(a, rule)) continue;
        const verb = command.trimStart().split(/\s+/)[0];
        const queued = messageQueues[a.id] ?? [];
        if (queued.some((m) => m.text.trimStart().startsWith(verb))) continue;
        // The latch, compact only. `used` reaches this gate from Claude's status
        // line, which only reports after an API call. A /compact on an agent that
        // has done nothing since the last one makes no call at all — Claude refuses
        // it locally with "Not enough messages to compact" — so the count stays
        // byte-identical and the pressure gate passes on the same number the next
        // cycle, and the next. Seen in the wild: /compact every hour for 15 straight
        // hours at exactly 400958 tokens, then 11 more at exactly 221772, each a
        // no-op the agent still had to read and answer. Higher thresholds make it
        // rarer, not absent: any agent parked above its bar repeats forever.
        //
        // So remember the count at the last compact queued and skip while it is
        // byte-identical. Deliberately equality and not "hasn't grown": the rule's
        // thresholds own that decision, and an agent still above them deserves its
        // /compact whether the count moved up or down. A frozen count is the one
        // state those thresholds cannot reason about, because nothing they could do
        // would ever change it. /clear needs no equivalent — the queue drain zeroes
        // the store reading when it lands.
               const used = a.contextTokens ?? 0;
        if (action === 'compact' && lastCompactUsed.current[a.id] === used) continue;
        // The latch is written at successful DELIVERY (see the flush() dispatch
        // callback below), not here. Writing it at enqueue time recorded
        // "already compacted at N tokens" for a compaction that might never
        // actually happen — e.g. blocked by the gate just above, or a failed
        // send — silently latching out every future attempt at that count.
        // compactUsed rides on the queued message so the delivery site knows
        // which count to latch.
        enqueueMessage(a.id, command, action === 'compact' ? { compactUsed: used } : undefined);
      }
    };

    // The typed `onContextTrigger` arrives with the main-process/preload change
    // that emits it; access it defensively so this lands independently of that.
    const off = (window.cth as unknown as {
      onContextTrigger?: (
        cb: (p: { action: 'compact' | 'clear'; rule: ContextRule }) => void
      ) => () => void;
    }).onContextTrigger?.((p) => {
      if (!p?.rule) return;
      fire(p.action === 'clear' ? 'clear' : 'compact', p.rule);
    });

    // LEGACY fallback: main still emits the old parameterless auto-compact until
    // it switches over. Treat it as the default compact rule so behaviour is
    // continuous across that landing. Harmless if both fire — the dedupe above
    // drops the duplicate.
    const offLegacy = window.cth.onAutoCompact(
      () => fire('compact', DEFAULT_CONTEXT_TRIGGER.compact)
    );

    return () => { off?.(); offLegacy?.(); };
  }, [config?.onboardingComplete]);
}
