// Workspace tree model + pane operations + localStorage round-trip.
//
// Node = Pane | Split
//   Pane  = { id, type:"pane",  tabs, activeTabId, scrollTopByTabId, search, expanded }
//   Split = { id, type:"split", direction:"h"|"v", ratio, a, b }
// Tab    = { id, sessionId, provider, label, project, loaded, items, start, end, total,
//            terminal: { session, detached } }
//
// Each tab owns its own tmux terminal state, so two tabs on the same pane
// can each carry their own resumable session and switching between them
// swaps which xterm is currently mounted (or shows history if a tab has
// no session).

import { uid, isNearBottom } from "./util.js";
import {
  state, runtime, el, paneBodyResizeObserver,
  LS_WORKSPACE, PROVIDERS,
} from "./state.js";

// ---- tree helpers ----------------------------------------------------------

export function makePane(tabs = [], activeTabId = null) {
  return {
    id: uid("pane"), type: "pane", tabs, activeTabId,
    scrollTopByTabId: {},
    search: { open: false, query: "" },
    expanded: false,  // when true, all <details> in the body stay open
  };
}

/** Live xterm state for the currently-active tab in `pane`. Returns the same
 *  shape `{ session, detached }` that a tab carries, or null if there's no
 *  active tab. Centralised so callers don't have to remember the lookup. */
export function activeTabTerminal(pane) {
  if (!pane) return null;
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  return tab ? (tab.terminal || null) : null;
}

export function makeSplit(direction, a, b, ratio = 1) {
  return { id: uid("split"), type: "split", direction, ratio, a, b };
}

export function walkPanes(node, fn) {
  if (node.type === "pane") fn(node);
  else { walkPanes(node.a, fn); walkPanes(node.b, fn); }
}

export function findPane(root, paneId) {
  if (root.type === "pane") return root.id === paneId ? root : null;
  return findPane(root.a, paneId) || findPane(root.b, paneId);
}

export function firstPaneIn(node) {
  if (node.type === "pane") return node;
  return firstPaneIn(node.a);
}

/** Replace an existing node reference anywhere in the tree. */
export function replaceNode(target, replacement) {
  if (state.workspace.root === target) { state.workspace.root = replacement; return true; }
  function walk(node) {
    if (node.type !== "split") return false;
    if (node.a === target) { node.a = replacement; return true; }
    if (node.b === target) { node.b = replacement; return true; }
    return walk(node.a) || walk(node.b);
  }
  return walk(state.workspace.root);
}

/** Find the split that directly contains `paneId`, plus which side it's on. */
export function findParentSplit(root, paneId) {
  if (root.type !== "split") return null;
  if ((root.a.type === "pane" && root.a.id === paneId)) return { split: root, side: "a" };
  if ((root.b.type === "pane" && root.b.id === paneId)) return { split: root, side: "b" };
  return findParentSplit(root.a, paneId) || findParentSplit(root.b, paneId);
}

// ---- persistence ----------------------------------------------------------

export function cloneForStorage(node) {
  if (node.type === "pane") {
    return {
      id: node.id, type: "pane",
      activeTabId: node.activeTabId,
      scrollTopByTabId: node.scrollTopByTabId || {},
      search: {
        open: !!node.search?.open,
        query: String(node.search?.query || ""),
      },
      expanded: !!node.expanded,
      tabs: node.tabs.map(t => ({
        id: t.id, sessionId: t.sessionId, provider: t.provider,
        label: t.label, project: t.project,
        terminal: {
          session: t.terminal?.session ? String(t.terminal.session) : null,
          detached: !!t.terminal?.detached,
        },
      })),
    };
  }
  return {
    id: node.id, type: "split",
    direction: node.direction, ratio: node.ratio,
    a: cloneForStorage(node.a), b: cloneForStorage(node.b),
  };
}

export function rehydrate(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "pane") {
    const tabs = Array.isArray(node.tabs) ? node.tabs.map(t => {
      const tt = t.terminal && typeof t.terminal === "object" ? t.terminal : null;
      return {
        id: String(t.id || uid("tab")),
        sessionId: String(t.sessionId || ""),
        provider: PROVIDERS.includes(t.provider) ? t.provider : "claude",
        label: String(t.label || ""),
        project: String(t.project || ""),
        loaded: false, items: [], start: 0, end: 0, total: 0,
        terminal: {
          // Reconciled against the live jobs list after workspace render.
          session: tt?.session ? String(tt.session) : null,
          detached: !!tt?.detached,
        },
      };
    }) : [];
    const ids = new Set(tabs.map(t => t.id));
    const activeTabId = ids.has(node.activeTabId) ? node.activeTabId : (tabs[0]?.id || null);
    const savedSearch = node.search && typeof node.search === "object" ? node.search : null;

    // Migration: the old layout stored `terminal` on the pane itself. If
    // we see a legacy field and the active tab doesn't already carry one,
    // copy it over so a reload after the upgrade keeps the live xterm.
    const legacy = node.terminal && typeof node.terminal === "object" ? node.terminal : null;
    if (legacy?.session && activeTabId) {
      const active = tabs.find(t => t.id === activeTabId);
      if (active && !active.terminal.session) {
        active.terminal = {
          session: String(legacy.session),
          detached: !!legacy.detached,
        };
      }
    }

    return {
      id: String(node.id || uid("pane")),
      type: "pane",
      tabs,
      activeTabId,
      scrollTopByTabId: (node.scrollTopByTabId && typeof node.scrollTopByTabId === "object") ? node.scrollTopByTabId : {},
      search: {
        open: !!savedSearch?.open,
        query: String(savedSearch?.query || ""),
      },
      expanded: !!node.expanded,
    };
  }
  if (node.type === "split") {
    const a = rehydrate(node.a);
    const b = rehydrate(node.b);
    if (!a || !b) return null;
    const dir = node.direction === "v" ? "v" : "h";
    const ratio = Number.isFinite(node.ratio) ? Math.min(0.9, Math.max(0.1, node.ratio)) : 0.5;
    return { id: String(node.id || uid("split")), type: "split", direction: dir, ratio, a, b };
  }
  return null;
}

export function loadWorkspaceFromStorage() {
  try {
    const raw = localStorage.getItem(LS_WORKSPACE);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.root) return null;
    const root = rehydrate(data.root);
    if (!root) return null;
    let focusedPaneId = data.focusedPaneId || null;
    if (!focusedPaneId || !findPane(root, focusedPaneId)) {
      focusedPaneId = firstPaneIn(root).id;
    }
    return { root, focusedPaneId };
  } catch { return null; }
}

export function persistWorkspace() {
  try {
    localStorage.setItem(LS_WORKSPACE, JSON.stringify({
      root: cloneForStorage(state.workspace.root),
      focusedPaneId: state.workspace.focusedPaneId,
    }));
  } catch { /* quota */ }
}

// ---- runtime teardown helper ----------------------------------------------

/** Swap two panes' positions inside the tree.
 *
 *  Tree change: just swaps the two Pane references inside their parent
 *  Split slots (or at workspace.root). Nothing else in the structure moves,
 *  so every Split.ratio — i.e. every visible slot size — stays put. The
 *  content of each slot moves; the slot itself doesn't.
 *
 *  DOM change: we also swap the live `<section class="pane">` elements via
 *  replaceWith + placeholder, so xterm terminals, EventSource streams,
 *  scroll positions, and search highlights all survive the move. No
 *  renderWorkspace() call.
 */
export function swapPanes(idA, idB) {
  if (idA === idB) return false;
  const root = state.workspace.root;
  const paneA = findPane(root, idA);
  const paneB = findPane(root, idB);
  if (!paneA || !paneB) return false;

  const parentA = findParentSplit(root, idA);
  const parentB = findParentSplit(root, idB);

  // With two distinct pane ids, at least one has a parent split (root can
  // hold only one node at a time).
  if (!parentA && !parentB) return false;

  if (!parentA) {
    state.workspace.root = paneB;
    parentB.split[parentB.side] = paneA;
  } else if (!parentB) {
    state.workspace.root = paneA;
    parentA.split[parentA.side] = paneB;
  } else if (parentA.split === parentB.split) {
    // Sibling swap inside the same split — flip the two slots.
    const split = parentA.split;
    const tmp = split[parentA.side];
    split[parentA.side] = split[parentB.side];
    split[parentB.side] = tmp;
  } else {
    parentA.split[parentA.side] = paneB;
    parentB.split[parentB.side] = paneA;
  }

  // DOM swap using a placeholder so same-parent swaps also work.
  const elA = el.workspace.querySelector(`.pane[data-pane-id="${idA}"]`);
  const elB = el.workspace.querySelector(`.pane[data-pane-id="${idB}"]`);
  if (elA && elB) {
    // Capture scroll state *before* the DOM dance. `replaceWith()` detaches
    // the element transiently, and some browsers reset scrollTop when an
    // element is re-inserted into a container with different dimensions —
    // which is exactly what happens when we swap two slots with different
    // split ratios. We restore after the swap, snapping to bottom if the
    // pane was near-bottom so a resized slot doesn't leave us mid-history.
    const bodyElA = elA.querySelector(":scope > .pane-body");
    const bodyElB = elB.querySelector(":scope > .pane-body");
    const snapA = bodyElA ? { atBottom: isNearBottom(bodyElA), top: bodyElA.scrollTop } : null;
    const snapB = bodyElB ? { atBottom: isNearBottom(bodyElB), top: bodyElB.scrollTop } : null;

    const placeholder = document.createElement("div");
    elA.replaceWith(placeholder);
    elB.replaceWith(elA);
    placeholder.replaceWith(elB);

    requestAnimationFrame(() => {
      if (bodyElA && snapA) {
        bodyElA.scrollTop = snapA.atBottom ? bodyElA.scrollHeight : snapA.top;
      }
      if (bodyElB && snapB) {
        bodyElB.scrollTop = snapB.atBottom ? bodyElB.scrollHeight : snapB.top;
      }
    });
  }

  persistWorkspace();
  return true;
}

/** Fully dispose of a pane's runtime state (timers, observers, xterm, SSE).
 *  Called whenever a pane is removed from the tree. */
export function disposePaneRuntime(paneId) {
  const rt = runtime.get(paneId);
  if (!rt) return;
  if (rt.pollTimer) clearTimeout(rt.pollTimer);
  if (rt.searchDebounce) clearTimeout(rt.searchDebounce);
  if (rt.bodyEl) paneBodyResizeObserver.unobserve(rt.bodyEl);
  if (rt.terminal) {
    try { rt.terminal.es?.close(); } catch { /* ignore */ }
    try { rt.terminal.term?.dispose(); } catch { /* ignore */ }
  }
  runtime.delete(paneId);
}
