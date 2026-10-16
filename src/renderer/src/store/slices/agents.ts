/**
 * Agents on the floor: the live roster, archived and restorable agents, selection,
 * per-agent feed and tool counts, and every mutation of them (persisted to the roster).
 */
import type { StateCreator } from 'zustand';
import { preferredAgentRole } from '@shared/agentRole';
import { refocusAfterRemoval } from '../focusMode';
import type { Agent, GodStatus } from '../types';
import { persistAgents, touchesDurableAgentField, persistArchived, persistRestorable, persistQueues, initialAgents, initialArchivedAgents, initialRestorableAgents, initialSelectedId } from '../persistence';
import type { State } from '../store';

export interface AgentsSlice {
  agents: Agent[];
  /** Agents whose terminal was closed — retained + flagged, kept off the active
   *  roster/floor. The hive registry retains them durably; this mirrors them for
   *  the renderer's "Archived" view. */
  archivedAgents: Agent[];
  /** Workers from the previous session whose terminal died with the app (quit /
   *  crash). Kept with their full spawn recipe (id, cwd, model, command) so the
   *  user can one-click respawn them with the SAME agent id — memory, inbox and
   *  registry entry reattach by themselves. God/assistant are excluded (they
   *  auto-respawn). */
  restorableAgents: Agent[];
  selectedId: string | null;
  feeds: Record<string, string[]>;
  godStatus: GodStatus;
  /** Per-agent tool-call count this session — a lightweight activity/usage proxy
   *  shown in the command center (interactive sessions don't expose billed $). */
  toolCounts: Record<string, number>;
  bumpToolCount: (id: string) => void;
  setGodStatus: (status: GodStatus) => void;
  select: (id: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  /** Copy durable hive roles onto roster descriptions (and the reverse is a
   *  no-op when the roster already has a real job string). */
  syncDescriptionsFromRoles: (roles: Record<string, string>) => void;
  /** Persist a display-name change to both the hive registry and renderer roster.
   *  The agent id and all id-derived paths remain unchanged. */
  renameAgent: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  setAgentNote: (id: string, note: string) => void;
  pushFeed: (id: string, line: string) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  /** Archive an agent (its terminal was closed): move it from the active roster
   *  into `archivedAgents` with its PTY cleared. Retained + flagged, NOT deleted. */
  archiveAgent: (id: string) => void;
  /** Permanently forget an archived agent (drops the renderer entry only; the
   *  hive registry keeps its record). */
  removeArchivedAgent: (id: string) => void;
  /** Drop one agent from the restorable list (it was respawned or dismissed). */
  removeRestorableAgent: (id: string) => void;
  reorderAgents: (fromId: string, toId: string) => void;
  /** Drop persisted agents whose PTY is no longer alive in the main process.
   *  Called once at startup so a renderer reload (e.g. after the laptop sleeps)
   *  restores still-running agents and only removes truly-dead ones. */
  reconcileWithLivePtys: (livePtyIds: string[]) => void;
}

export const createAgentsSlice: StateCreator<State, [], [], AgentsSlice> = (set, get) => ({
  agents: initialAgents,
  archivedAgents: initialArchivedAgents,
  restorableAgents: initialRestorableAgents,
  selectedId: initialSelectedId,
  feeds: {},
  godStatus: 'booting',
  toolCounts: {},
  bumpToolCount: (id) =>
    set((s) => ({ toolCounts: { ...s.toolCounts, [id]: (s.toolCounts[id] ?? 0) + 1 } })),
  setGodStatus: (status) => set({ godStatus: status }),
  select: (id) => set((s) => { persistAgents(s.agents, id); return { selectedId: id, ccTabRequest: null }; }),
  updateAgent: (id, patch) =>
    set((s) => {
      const agents = s.agents.map(a => a.id === id ? { ...a, ...patch } : a);
      // Persist only when something DURABLE changed. `updateAgent` is also the
      // pty parser's per-chunk write (status/action/progress), so persisting
      // unconditionally would rewrite localStorage on every burst of terminal
      // output. Persisting nothing was worse: a model or command change lived
      // only in memory, so the selector snapped back to the old model on reload
      // and restore relaunched the old command.
      if (touchesDurableAgentField(patch)) persistAgents(agents, s.selectedId);
      return { agents };
    }),
  syncDescriptionsFromRoles: (roles) =>
    set((s) => {
      const apply = (list: Agent[]): Agent[] => {
        let changed = false;
        const next = list.map((a) => {
          const description = preferredAgentRole(a.description, roles[a.id], !!a.isGod);
          if (description === a.description) return a;
          changed = true;
          return { ...a, description };
        });
        return changed ? next : list;
      };
      const agents = apply(s.agents);
      const archivedAgents = apply(s.archivedAgents);
      const restorableAgents = apply(s.restorableAgents);
      if (agents === s.agents && archivedAgents === s.archivedAgents && restorableAgents === s.restorableAgents) {
        return s;
      }
      persistAgents(agents, s.selectedId);
      if (archivedAgents !== s.archivedAgents) persistArchived(archivedAgents);
      if (restorableAgents !== s.restorableAgents) persistRestorable(restorableAgents);
      return { agents, archivedAgents, restorableAgents };
    }),
  renameAgent: async (id, name) => {
    try {
      const result = await window.cth.hiveRenameAgent(id, name);
      if (!result.ok || !result.name) return { ok: false, error: result.error ?? 'Could not rename agent' };
      const nextName = result.name;

      set((s) => {
        const rename = (agents: Agent[]): Agent[] =>
          agents.map((agent) => agent.id === id ? { ...agent, name: nextName } : agent);
        const agents = rename(s.agents);
        const archivedAgents = rename(s.archivedAgents);
        const restorableAgents = rename(s.restorableAgents);
        persistAgents(agents, s.selectedId);
        persistArchived(archivedAgents);
        persistRestorable(restorableAgents);
        return { agents, archivedAgents, restorableAgents };
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not rename agent' };
    }
  },
  setAgentNote: (id, note) =>
    set((s) => {
      const agents = s.agents.map((a) => a.id === id ? { ...a, note } : a);
      persistAgents(agents, s.selectedId);
      return { agents };
    }),
  pushFeed: (id, line) =>
    set((s) => ({ feeds: { ...s.feeds, [id]: [...(s.feeds[id] ?? []), line] } })),
  addAgent: (agent) =>
    set((s) => {
      // Idempotent by id: a MAIN-initiated spawn broadcast (hive:agentSpawned, e.g.
      // a voice hire) and a renderer-initiated hire (AddAgentModal) can both call
      // addAgent for the same id — never render a duplicate card. The first writer
      // (richer local record) wins; the broadcast is a no-op for it.
      if (s.agents.some((a) => a.id === agent.id)) return s;
      // GOD enters at the HEAD, everyone else at the tail. Michael's position was
      // otherwise decided by a race he usually lost: useHive's bootstrap removes
      // the restored god entry, then spawns him asynchronously (a setTimeout, a
      // listPtys round-trip, and a --resume that seeds a transcript first), while
      // useRestoreTeam respawns last session's workers in parallel. Whoever
      // resolved first landed first, so a session with workers to restore put the
      // BOSS card fourth — and persistAgents() then wrote that order to disk, so
      // it stuck across restarts instead of flickering once.
      //
      // Fixed at insertion rather than by sorting in AgentStrip: the strip has
      // drag-reorder (reorderAgents) whose whole point is a persisted manual
      // order, and a god-first sort at render time would silently override the
      // user's own arrangement every frame. This just makes the head the honest
      // default; a deliberate drag still wins and still persists.
      const agents = agent.isGod ? [agent, ...s.agents] : [...s.agents, agent];
      // Re-spawning an archived agent un-archives it: an id is active xor archived.
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== agent.id);
      // A live (re)spawn also consumes any restorable entry for the same id.
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== agent.id);
      persistAgents(agents, agent.id);
      persistArchived(archivedAgents);
      if (restorableAgents.length !== s.restorableAgents.length) persistRestorable(restorableAgents);
      return {
        agents,
        archivedAgents,
        restorableAgents,
        selectedId: agent.id,
        feeds: { ...s.feeds, [agent.id]: s.feeds[agent.id] ?? [] }
      };
    }),
  removeAgent: (id) =>
    set((s) => {
      const agents = s.agents.filter(a => a.id !== id);
      const { [id]: _gone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      const fullscreenAgentId = refocusAfterRemoval(s.fullscreenAgentId, agents, selectedId);
      persistAgents(agents, selectedId);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, feeds, selectedId, messageQueues, fullscreenAgentId };
    }),
  archiveAgent: (id) =>
    set((s) => {
      const target = s.agents.find((a) => a.id === id);
      if (!target) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      // Retain a flagged copy; the PTY is gone, so clear all live run-state.
      const archivedEntry: Agent = {
        ...target,
        archived: true,
        ptyId: undefined,
        status: 'idle',
        action: 'archived',
        carrying: undefined,
        currentStation: undefined
      };
      const archivedAgents = [...s.archivedAgents.filter((a) => a.id !== id), archivedEntry];
      const { [id]: _feedGone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      const fullscreenAgentId = refocusAfterRemoval(s.fullscreenAgentId, agents, selectedId);
      persistAgents(agents, selectedId);
      persistArchived(archivedAgents);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, archivedAgents, feeds, selectedId, messageQueues, fullscreenAgentId };
    }),
  removeArchivedAgent: (id) =>
    set((s) => {
      if (!s.archivedAgents.some((a) => a.id === id)) return s;
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== id);
      persistArchived(archivedAgents);
      return { archivedAgents };
    }),
  removeRestorableAgent: (id) =>
    set((s) => {
      if (!s.restorableAgents.some((a) => a.id === id)) return s;
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== id);
      persistRestorable(restorableAgents);
      return { restorableAgents };
    }),
  reorderAgents: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return s;
      const from = s.agents.findIndex((a) => a.id === fromId);
      const to = s.agents.findIndex((a) => a.id === toId);
      if (from === -1 || to === -1) return s;
      const agents = [...s.agents];
      const [moved] = agents.splice(from, 1);
      agents.splice(to, 0, moved);
      // Persist the new roster order so it survives a reload (same slim key the
      // rest of the roster uses). selectedId is unchanged by a reorder.
      persistAgents(agents, s.selectedId);
      return { agents };
    }),
  reconcileWithLivePtys: (livePtyIds) =>
    set((s) => {
      const live = new Set(livePtyIds);
      // Keep agents with no PTY (synthetic) or whose PTY is still alive.
      const agents = s.agents.filter((a) => !a.ptyId || live.has(a.ptyId));
      if (agents.length === s.agents.length) return s;
      // Workers whose terminal died with the previous session become restorable
      // (full spawn recipe retained) instead of silently vanishing. God and the
      // prep assistant are excluded — they auto-respawn at boot.
      const dead = s.agents.filter(
        (a) => a.ptyId && !live.has(a.ptyId) && !a.isGod && !a.isAssistant
      );
      const restorableAgents = [
        ...s.restorableAgents.filter((r) => !dead.some((d) => d.id === r.id)),
        ...dead
      ];
      const feeds: Record<string, string[]> = {};
      for (const a of agents) feeds[a.id] = s.feeds[a.id] ?? [];
      const selectedId = agents.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : (agents[0]?.id ?? null);
      const fullscreenAgentId = refocusAfterRemoval(s.fullscreenAgentId, agents, selectedId);
      persistAgents(agents, selectedId);
      persistRestorable(restorableAgents);
      return { agents, feeds, selectedId, restorableAgents, fullscreenAgentId };
    })
});
