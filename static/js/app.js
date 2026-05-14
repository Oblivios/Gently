// Entry point — wires together global listeners, restores workspace,
// then kicks off the initial session fetch.

import {
  state, runtime, el,
  LS_LIVE, LS_SIDEBAR_W, LS_GROUP_MODE, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT,
  persistEnabled, toast,
} from "./state.js";
import { escapeHtml } from "./util.js";
import {
  makePane, walkPanes, loadWorkspaceFromStorage,
} from "./workspace.js";
import {
  renderWorkspace, resetLayout,
} from "./render.js";
import {
  applyChipState, applyFilter, renderSidebar,
  fetchSessions, moveCursor, openCursor,
} from "./sidebar.js";
import { schedulePaneLoop } from "./loading.js";
import { reconcileTerminalSessions } from "./terminal.js";
import {
  listSavedWorkspaces, saveWorkspaceAs, loadWorkspace, deleteWorkspace,
} from "./workspaces.js";
// Side-effect import: wires up the "+ New conversation" modal.
import "./newconv.js";
// Side-effect import: wires up the Ctrl+K command palette.
import "./palette.js";

// ---- filter chips --------------------------------------------------------

for (const c of el.chips) {
  c.addEventListener("click", () => {
    const p = c.dataset.provider;
    if (state.enabled.has(p)) {
      if (state.enabled.size === 1) return;  // keep at least one provider
      state.enabled.delete(p);
    } else {
      state.enabled.add(p);
    }
    persistEnabled();
    applyChipState();
    applyFilter();
    renderSidebar();
  });
}

// ---- sidebar search + keyboard nav ---------------------------------------

let searchTimer = null;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value;
    fetchSessions(state.query);
  }, 180);
});
el.search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") el.search.blur();
  else if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(+1); }
  else if (e.key === "ArrowUp")   { e.preventDefault(); moveCursor(-1); }
  else if (e.key === "Enter")     { e.preventDefault(); openCursor(); }
});
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); el.search.focus(); el.search.select(); }
  else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveCursor(+1); }
  else if (e.key === "ArrowUp"   || e.key === "k") { e.preventDefault(); moveCursor(-1); }
  else if (e.key === "Enter") { e.preventDefault(); openCursor(); }
});

// ---- sidebar resizer -----------------------------------------------------

if (el.sidebarResizer) {
  el.sidebarResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.sidebarResizer.setPointerCapture(e.pointerId);
    el.sidebarResizer.classList.add("dragging");
    const onMove = (ev) => {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ev.clientX));
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    };
    const onUp = () => {
      el.sidebarResizer.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim();
      const w = parseInt(cur, 10);
      if (Number.isFinite(w)) localStorage.setItem(LS_SIDEBAR_W, String(w));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  el.sidebarResizer.addEventListener("dblclick", () => {
    document.documentElement.style.setProperty("--sidebar-w", `${SIDEBAR_DEFAULT}px`);
    localStorage.setItem(LS_SIDEBAR_W, String(SIDEBAR_DEFAULT));
  });
}

// ---- sidebar footer buttons ----------------------------------------------

el.refreshBtn.addEventListener("click", async () => {
  el.refreshBtn.disabled = true;
  try { await fetchSessions(state.query); toast("Re-scanned sessions"); }
  finally { el.refreshBtn.disabled = false; }
});

if (el.groupBtn) {
  el.groupBtn.addEventListener("click", () => {
    state.groupMode = state.groupMode === "project" ? "recency" : "project";
    localStorage.setItem(LS_GROUP_MODE, state.groupMode);
    renderSidebar();
  });
}

el.resetLayoutBtn.addEventListener("click", () => {
  if (!confirm("Reset to a single empty pane? Your tabs will close.")) return;
  resetLayout();
  toast("Layout reset");
});

// ---- workspaces popover --------------------------------------------------

async function refreshWorkspacesList() {
  const host = el.workspacesList;
  if (!host) return;
  const items = await listSavedWorkspaces();
  if (items.length === 0) {
    host.innerHTML = `<div class="workspaces-empty">No saved workspaces yet.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "workspaces-item";
    row.innerHTML = `
      <button class="workspaces-load" type="button" title="Load this workspace">
        <span class="ws-name"></span>
        <span class="ws-meta"></span>
      </button>
      <button class="workspaces-del" type="button" title="Delete this workspace" aria-label="Delete">&times;</button>
    `;
    row.querySelector(".ws-name").textContent = it.name;
    const when = it.mtime ? new Date(it.mtime * 1000).toLocaleString() : "";
    row.querySelector(".ws-meta").textContent = `${it.tabs} tab${it.tabs === 1 ? "" : "s"}${when ? " · " + when : ""}`;
    row.querySelector(".workspaces-load").addEventListener("click", async () => {
      if (!confirm(`Load workspace "${it.name}"? Your current panes will be replaced.`)) return;
      try { await loadWorkspace(it.name); closeWorkspacesPopover(); }
      catch (e) { toast(`Load failed: ${e.message}`); }
    });
    row.querySelector(".workspaces-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete workspace "${it.name}"? This can't be undone.`)) return;
      try { await deleteWorkspace(it.name); await refreshWorkspacesList(); }
      catch (e2) { toast(`Delete failed: ${e2.message}`); }
    });
    frag.appendChild(row);
  }
  host.replaceChildren(frag);
}

function openWorkspacesPopover() {
  if (!el.workspacesPopover) return;
  el.workspacesPopover.hidden = false;
  el.workspacesBtn?.setAttribute("aria-expanded", "true");
  refreshWorkspacesList();
  // Focus the name input so typing + Enter is the fastest save path.
  requestAnimationFrame(() => el.workspacesSaveName?.focus());
}

function closeWorkspacesPopover() {
  if (!el.workspacesPopover) return;
  el.workspacesPopover.hidden = true;
  el.workspacesBtn?.setAttribute("aria-expanded", "false");
}

if (el.workspacesBtn) {
  el.workspacesBtn.addEventListener("click", () => {
    if (el.workspacesPopover?.hidden) openWorkspacesPopover();
    else closeWorkspacesPopover();
  });
}
if (el.workspacesClose) {
  el.workspacesClose.addEventListener("click", closeWorkspacesPopover);
}
if (el.workspacesSave) {
  el.workspacesSave.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (el.workspacesSaveName?.value || "").trim();
    if (!name) return;
    // Valid characters mirror the server's regex.
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(name)) {
      toast("Name must be letters/digits/space/-/_ (1–64 chars)");
      return;
    }
    const existing = await listSavedWorkspaces();
    if (existing.some(w => w.name === name)) {
      if (!confirm(`Overwrite workspace "${name}"?`)) return;
    }
    try {
      await saveWorkspaceAs(name);
      if (el.workspacesSaveName) el.workspacesSaveName.value = "";
      await refreshWorkspacesList();
    } catch (err) {
      toast(`Save failed: ${err.message}`);
    }
  });
}
// Close on outside click so the popover feels like a menu, not a panel.
document.addEventListener("click", (e) => {
  if (!el.workspacesPopover || el.workspacesPopover.hidden) return;
  if (el.workspacesPopover.contains(e.target)) return;
  if (el.workspacesBtn?.contains(e.target)) return;
  closeWorkspacesPopover();
});

el.pollToggle.checked = state.live;
el.pollToggle.addEventListener("change", () => {
  state.live = el.pollToggle.checked;
  localStorage.setItem(LS_LIVE, String(state.live));
  if (state.live) walkPanes(state.workspace.root, p => schedulePaneLoop(p));
  else for (const rt of runtime.values()) if (rt.pollTimer) clearTimeout(rt.pollTimer);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    for (const rt of runtime.values()) if (rt.pollTimer) clearTimeout(rt.pollTimer);
  } else {
    walkPanes(state.workspace.root, p => schedulePaneLoop(p));
  }
});

// ---- boot ----------------------------------------------------------------

applyChipState();

// Restore or create workspace.
const restored = loadWorkspaceFromStorage();
if (restored) {
  state.workspace = restored;
} else {
  const pane = makePane();
  state.workspace = { root: pane, focusedPaneId: pane.id };
}
renderWorkspace();

// Drop any persisted terminal sessions that the server no longer has.
reconcileTerminalSessions();

fetchSessions("").catch(err => {
  el.sessionList.innerHTML = `<div class="empty-sidebar" style="color:var(--danger)">Failed to load: ${escapeHtml(err.message)}</div>`;
});
