import { create } from 'zustand';
import type { Agent } from './types';
import { type AgentsSlice, createAgentsSlice } from './slices/agents';
import { type QueueSlice, createQueueSlice } from './slices/queue';
import { type UiSlice, createUiSlice } from './slices/ui';
import { type IntegrationsSlice, createIntegrationsSlice } from './slices/integrations';

// The store's types live in ./types; re-exported so callers keep importing from '@/store/store'.
export type { ToolKind, StationKind, BlockReason, Agent, FeedEntry, QueuedMessage, SidebarTab, GodStatus } from './types';

export interface State extends AgentsSlice, QueueSlice, UiSlice, IntegrationsSlice {}

export const useStore = create<State>()((...a) => ({
  ...createAgentsSlice(...a),
  ...createQueueSlice(...a),
  ...createUiSlice(...a),
  ...createIntegrationsSlice(...a)
}));

export function selectedAgent(s: State): Agent | undefined {
  return s.agents.find(a => a.id === s.selectedId);
}

/** Whether the Command Center's Trigger History tab has anything to be about
 *  yet: an organisation key is set, or at least one webhook exists. Derived from
 *  the two mirrors rather than stored beside them, so it cannot fall out of step
 *  with the thing it describes. Use as `useStore(triggerHistoryVisible)`. */
export function triggerHistoryVisible(s: State): boolean {
  return s.webhookTriggers.length > 0 || s.orgTrigger.apiKey.trim() !== '';
}
