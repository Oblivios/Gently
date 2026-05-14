// Per-tab lifecycle: initial load, "load earlier" window extension, and the
// polling loop that appends new messages as they appear in the session file.

import { api, state, runtime, POLL_MS, INITIAL_WINDOW, EARLIER_WINDOW, toast } from "./state.js";
import { isNearBottom } from "./util.js";
import { appendMessagesTo } from "./messages.js";
import { renderPaneBody, renderPaneHeader, applyExpandedState } from "./render.js";
import { persistWorkspace } from "./workspace.js";
import { maybeRerunSearch } from "./search.js";

export async function ensureTabLoaded(pane, tab) {
  if (!tab || tab.loaded) {
    schedulePaneLoop(pane);
    return;
  }
  // Ephemeral "new conversation" tabs have no sessionId yet — nothing to fetch.
  if (!tab.sessionId) {
    tab.loaded = true;
    return;
  }
  const seq = ++state.loadSeq;
  tab._seq = seq;
  try {
    const data = await api(`/api/sessions/${tab.provider}/${tab.sessionId}?limit=${INITIAL_WINDOW}`);
    if (tab._seq !== seq) return;
    tab.project = data.project || tab.project;
    tab.label = data.summary || tab.label;
    tab.items = data.items || [];
    tab.start = data.start ?? 0;
    tab.end = data.end ?? tab.items.length;
    tab.total = data.total ?? tab.items.length;
    tab.loaded = true;
    // Skip the body rebuild when the pane is currently showing the tmux
    // terminal — otherwise we'd tear down the live xterm + SSE connection
    // just to swap in the same terminal again, flashing stale content and
    // forcing a full log re-stream from offset 0.
    if (pane.activeTabId === tab.id && !(tab.terminal?.session && !tab.terminal?.detached)) renderPaneBody(pane);
    renderPaneHeader(pane); // label may have changed
    persistWorkspace();
    schedulePaneLoop(pane);
  } catch (e) {
    if (tab._seq !== seq) return;
    tab.loaded = true; // treat as loaded so we don't retry in a loop
    // 404 on a session almost always means the file is gone (project folder
    // was deleted, or the agent rotated it). Surface that distinctly so the
    // user knows the card is stale, and trigger a sidebar rescan so the
    // orphan disappears next paint.
    if (/^404\b/.test(e.message)) {
      tab._error = "Session file no longer exists. The folder may have been deleted.";
      import("./sidebar.js").then(m => m.fetchSessions(state.query)).catch(() => {});
    } else {
      tab._error = e.message;
    }
    if (pane.activeTabId === tab.id && !(tab.terminal?.session && !tab.terminal?.detached)) renderPaneBody(pane);
  }
}

export async function loadEarlier(pane, tab) {
  if (!tab.loaded || tab.start <= 0) return;
  try {
    const data = await api(`/api/sessions/${tab.provider}/${tab.sessionId}?limit=${EARLIER_WINDOW}&before=${tab.start}`);
    tab.items = [...(data.items || []), ...tab.items];
    tab.start = data.start ?? 0;
    const body = runtime.get(pane.id)?.bodyEl;
    // Preserve the apparent scroll position by pinning the distance to bottom
    // across the rebuild.
    const before = body ? (body.scrollHeight - body.scrollTop) : 0;
    renderPaneBody(pane);
    if (body) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight - before; });
  } catch (e) {
    toast(`Failed to load earlier: ${e.message}`);
  }
}

/** Load every hidden earlier message in one shot. The render pass that follows
 *  will block the main thread for as long as it takes to build the DOM for
 *  every message (can be multiple seconds for 10k-turn sessions); the caller
 *  is expected to surface that in the UI. */
export async function loadFull(pane, tab) {
  if (!tab.loaded || tab.start <= 0) return;
  try {
    // limit=0 → server returns items[0 : tab.start], i.e. everything older.
    const data = await api(`/api/sessions/${tab.provider}/${tab.sessionId}?limit=0&before=${tab.start}`);
    tab.items = [...(data.items || []), ...tab.items];
    tab.start = data.start ?? 0;
    const body = runtime.get(pane.id)?.bodyEl;
    const before = body ? (body.scrollHeight - body.scrollTop) : 0;
    renderPaneBody(pane);
    if (body) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight - before; });
  } catch (e) {
    toast(`Failed to load full: ${e.message}`);
  }
}

export function schedulePaneLoop(pane) {
  const rt = runtime.get(pane.id) || (runtime.set(pane.id, {}).get(pane.id));
  if (rt.pollTimer) clearTimeout(rt.pollTimer);
  if (!state.live) return;
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  if (!tab || !tab.loaded || !tab.sessionId) return;
  rt.pollTimer = setTimeout(() => pollPane(pane), POLL_MS);
}

async function pollPane(pane) {
  if (!state.live) return;
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  if (!tab || !tab.loaded) return;
  if (document.hidden) { schedulePaneLoop(pane); return; }
  const rt = runtime.get(pane.id);
  if (!rt || rt.pollInFlight) return;
  rt.pollInFlight = true;
  const body = rt.bodyEl;
  const shouldStick = body ? isNearBottom(body) : false;
  try {
    const data = await api(`/api/sessions/${tab.provider}/${tab.sessionId}/delta?offset=${tab.total}`);
    if (data.reset) {
      tab.loaded = false;
      await ensureTabLoaded(pane, tab);
      return;
    }
    const newItems = data.items || [];
    tab.total = data.total ?? (tab.total + newItems.length);
    if (newItems.length) {
      tab.items.push(...newItems);
      tab.end = tab.items.length + tab.start;
      // Only touch the DOM when the body is actually showing the history.
      // Terminal mode has its own live stream over SSE; appending history
      // bubbles into the terminal's body corrupts the xterm layout and
      // briefly paints the old history view on top of it.
      if (body && pane.activeTabId === tab.id && !(tab.terminal?.session && !tab.terminal?.detached)) {
        appendMessagesTo(body, newItems, tab.provider);
        applyExpandedState(pane);
        if (shouldStick) body.scrollTop = body.scrollHeight;
        maybeRerunSearch(pane, { scrollCurrent: false });
      }
      renderPaneHeader(pane);
    }
  } catch { /* swallow */ } finally {
    rt.pollInFlight = false;
    schedulePaneLoop(pane);
  }
}
