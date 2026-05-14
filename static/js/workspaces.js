// Named workspace store (server-backed). Save / load / delete the full
// pane tree as a single snapshot the user can switch between.

import { api, state, toast, runtime, paneBodyResizeObserver } from "./state.js";
import {
  cloneForStorage, rehydrate, firstPaneIn,
  persistWorkspace, disposePaneRuntime,
} from "./workspace.js";
import { renderWorkspace } from "./render.js";
import { reconcileTerminalSessions } from "./terminal.js";

export async function listSavedWorkspaces() {
  try {
    const data = await api("/api/workspaces");
    return data.workspaces || [];
  } catch {
    return [];
  }
}

export async function saveWorkspaceAs(name) {
  const payload = {
    name,
    data: {
      root: cloneForStorage(state.workspace.root),
      focusedPaneId: state.workspace.focusedPaneId,
    },
  };
  const res = await fetch("/api/workspaces/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || res.statusText);
  }
  toast(`Saved workspace “${name}”`);
}

export async function loadWorkspace(name) {
  const data = await api(`/api/workspaces/${encodeURIComponent(name)}`);
  const root = rehydrate(data.root);
  if (!root) throw new Error("invalid workspace data");
  const focused = data.focusedPaneId || firstPaneIn(root).id;

  // Dispose the current workspace's runtime before we drop the state ref,
  // so timers/xterm/SSE handles don't linger as ghosts in the map.
  for (const paneId of [...runtime.keys()]) disposePaneRuntime(paneId);

  state.workspace = { root, focusedPaneId: focused };
  renderWorkspace();
  persistWorkspace();
  // Kick the tmux-jobs reconciliation so any stale terminal sessions in the
  // loaded workspace are cleared.
  reconcileTerminalSessions();
  toast(`Loaded workspace “${name}”`);
}

export async function deleteWorkspace(name) {
  const res = await fetch("/api/workspaces/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || res.statusText);
  }
  toast(`Deleted workspace “${name}”`);
}
