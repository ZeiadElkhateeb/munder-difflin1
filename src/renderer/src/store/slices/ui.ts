/**
 * Layout and navigation: modals, focus mode / fullscreen, IDE, sidebar, Command Center
 * tab requests, task detail, office theme, and the hire-import review queue.
 */
import type { StateCreator } from 'zustand';
import type { ThemeId } from '@/scene/office/themeRegistry';
import type { HireManifest } from '@shared/hire';
import { EMPTY_HIRE_QUEUE, clearHireQueue, enqueueHires, finishCurrentHire, type HireReviewQueue } from '@shared/hireQueue';
import { focusOnLoad, restoreFocus } from '../focusMode';
import type { SidebarTab } from '../types';
import { LS_SIDEBAR_WIDTH, LS_SIDEBAR_TAB, LS_FOCUS_MODE, initialSidebarWidth, initialSidebarTab, initialPrefersFocusMode, initialSelectedId } from '../persistence';
import type { State } from '../store';

export interface UiSlice {
  addAgentOpen: boolean;
  setAddAgentOpen: (open: boolean) => void;
  fullscreenAgentId: string | null;
  /** Does the user work in focus mode by default? Persisted as a boolean, and
   *  written ONLY by an explicit toggle. Kept in the store rather than read once
   *  at construction because the roster arrives after the store does. */
  prefersFocusMode: boolean;
  setFullscreen: (id: string | null) => void;
  /** Move focus mode WITHOUT touching the preference. For the paths that re-home
   *  a focused agent that went away: the app is following the user, not being
   *  told what the user wants. `setFullscreen` is the explicit toggle. */
  refocusFullscreen: (id: string | null) => void;
  /** Re-apply the persisted preference now that the roster has changed. */
  restoreFocusMode: () => void;
  /** Absolute path queued for the IDE to open on next mount. Consumed-and-cleared
   *  by IdePanel, which routes it the same way a tree click would (Monaco for
   *  source, preview for markdown, the viewer for images). */
  ideInitialFile: string | null;
  /** Whether the full-window IDE panel (file manager + Monaco editor + git diff)
   *  is open. Toggled from the title-bar IDE button; a global feature surface,
   *  independent of the per-agent sidebar Files/Git tabs. */
  ideOpen: boolean;
  /** WHICH agent the IDE was opened FOR — set by whoever opens it.
   *
   *  The IDE used to infer its workspace purely from `selectedId`, which is a
   *  guess that is usually right and occasionally wrong: `setFullscreen` puts an
   *  agent's terminal on screen WITHOUT selecting it, so hitting IDE from a
   *  fullscreen terminal could open a different agent's directory than the one
   *  being looked at. That was invisible while the title said only "IDE" and the
   *  folder name; it becomes a flatly wrong agent NAME once the title names one.
   *  Callers therefore state their intent, and `selectedId` stays as the
   *  fallback for anything that genuinely has no particular agent in mind. */
  ideAgentId: string | null;
  /** Open an absolute path in the IDE — the ONE way to show a file.
   *
   *  v0.4.5 removed a second, worse file surface (a fullscreen overlay wrapping
   *  a bare Monaco). It could not scroll, had no tabs, no tree, and no git, and
   *  every file it opened was one click from "open in IDE" anyway. Everything
   *  that used to open it now comes here, so there is exactly one editor to fix
   *  when an editor bug shows up. */
  openFileInIde: (absPath: string) => void;
  /** Open/close the IDE. `agentId` names the agent whose workspace it should
   *  show; omit it only when the caller truly has no specific agent (the IDE
   *  then falls back to the selection and says so in its title). */
  setIdeOpen: (open: boolean, agentId?: string | null) => void;
  setIdeInitialFile: (path: string | null) => void;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  setSidebarWidth: (px: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
 // move agent fromId into toId's slot (AgentStrip drag-reorder) and persist the new order
  /** One-shot request to open a Command-Center tab (e.g. clicking the office
   *  task board → 'tasks'). `seq` makes repeated identical requests distinct. */
  ccTabRequest: { tab: string; seq: number } | null;
  requestCommandCenterTab: (tab: string) => void;
  /** The task whose detail overlay is open (rendered app-wide over the office
   *  floor — the card content grows: contracts, deps, the human Q&A trail). */
  taskDetailId: string | null;
  openTaskDetail: (id: string) => void;
  closeTaskDetail: () => void;
  /** Mirror of the active office theme (set by App on config load + by Settings
   *  on switch). OfficeFloor depends on this and rebuilds the scene on change. */
  officeTheme: ThemeId;
  setOfficeTheme: (theme: ThemeId) => void;
  /** Validated manifests waiting for one-at-a-time human review. */
  hireQueue: HireReviewQueue;
  enqueuePendingHires: (manifests: readonly HireManifest[]) => void;
  finishPendingHire: () => void;
  clearPendingHires: () => void;
}

export const createUiSlice: StateCreator<State, [], [], UiSlice> = (set, get) => ({
  addAgentOpen: false,
  ccTabRequest: null,
  requestCommandCenterTab: (tab) =>
    set((s) => ({ ccTabRequest: { tab, seq: (s.ccTabRequest?.seq ?? 0) + 1 } })),
  fullscreenAgentId: focusOnLoad(initialPrefersFocusMode, initialSelectedId),
  prefersFocusMode: initialPrefersFocusMode,
  ideInitialFile: null,
  ideOpen: false,
  ideAgentId: null,
  sidebarWidth: initialSidebarWidth,
  sidebarTab: initialSidebarTab,
  taskDetailId: null,
  openTaskDetail: (id) => set({ taskDetailId: id }),
  closeTaskDetail: () => set({ taskDetailId: null }),
  officeTheme: 'office',
  setOfficeTheme: (theme) => set({ officeTheme: theme }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  hireQueue: EMPTY_HIRE_QUEUE,
  enqueuePendingHires: (manifests) => set((s) => ({
    hireQueue: enqueueHires(s.hireQueue, manifests)
  })),
  finishPendingHire: () => set((s) => ({
    hireQueue: finishCurrentHire(s.hireQueue)
  })),
  clearPendingHires: () => set((s) => ({
    hireQueue: clearHireQueue(s.hireQueue)
  })),
  setFullscreen: (id) => {
    // Entering focus mode makes it the default view; leaving it clears that.
    // Only an explicit toggle writes the preference, so an agent closing under
    // you never silently changes how the app opens next time. Every non-explicit
    // mover goes through `refocusFullscreen` instead.
    try { window.localStorage.setItem(LS_FOCUS_MODE, id ? '1' : '0'); } catch { /* noop */ }
    set({ fullscreenAgentId: id, prefersFocusMode: !!id });
  },
  refocusFullscreen: (id) => set({ fullscreenAgentId: id }),
  restoreFocusMode: () =>
    set((s) => {
      const id = restoreFocus(s.prefersFocusMode, s.fullscreenAgentId, s.agents, s.selectedId);
      return id === s.fullscreenAgentId ? s : { fullscreenAgentId: id };
    }),
  openFileInIde: (absPath) => {
    const s = get();
    // Resolve the OWNING agent here rather than in each caller: a terminal link
    // or a Files-tab click often has nothing selected, and the IDE would
    // otherwise fall back to the selection and open the wrong workspace.
    const owner = s.agents.find((a) => absPath === a.cwd || absPath.startsWith(a.cwd + '/'));
    set({ ideInitialFile: absPath, ideOpen: true, ideAgentId: owner?.id ?? null });
  },
  // Closing CLEARS the target: the id is scoped to one IDE session, and a stale
  // one left behind would silently win over the selection on the next open from
  // a caller that passes nothing.
  setIdeOpen: (open, agentId) => set({ ideOpen: open, ideAgentId: open ? (agentId ?? null) : null }),
  setIdeInitialFile: (path) => set({ ideInitialFile: path }),
  setSidebarWidth: (px) => {
    const clamped = Math.min(1200, Math.max(320, Math.round(px)));
    try { window.localStorage.setItem(LS_SIDEBAR_WIDTH, String(clamped)); } catch { /* noop */ }
    set({ sidebarWidth: clamped });
  },
  setSidebarTab: (tab) => {
    try { window.localStorage.setItem(LS_SIDEBAR_TAB, tab); } catch { /* noop */ }
    set({ sidebarTab: tab });
  }
});
