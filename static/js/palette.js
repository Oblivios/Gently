// Command palette — Ctrl+K / Cmd+K.
//
// Keyboard launcher for everything that's also clickable in the UI: pane
// commands (split, close, toggle search, jump to prompt, copy …), workspace
// commands (save / load / delete / reset), and dynamic targets (sessions,
// saved workspaces). Items are subsequence-matched against the query and
// ranked: exact substring > prefix > subsequence in label > subsequence in
// subtitle.

import { state, el, toast, PROVIDER_LABEL } from "./state.js";
import { escapeHtml, shortProject } from "./util.js";
import {
  splitPane, closePane, resetLayout, addOrActivateTab,
  focusPane,
} from "./render.js";
import { findPane, walkPanes, firstPaneIn } from "./workspace.js";
import { toggleSearchBar } from "./search.js";
import { toggleTerminal } from "./terminal.js";
import {
  listSavedWorkspaces, saveWorkspaceAs, loadWorkspace, deleteWorkspace,
} from "./workspaces.js";

const els = {
  modal: document.getElementById("palette-modal"),
  input: document.getElementById("palette-input"),
  list:  document.getElementById("palette-list"),
};

let cursor = 0;
let currentItems = [];

// ---- item builders --------------------------------------------------------

function focusedPane() {
  if (!state.workspace) return null;
  return findPane(state.workspace.root, state.workspace.focusedPaneId)
      || firstPaneIn(state.workspace.root);
}

function activeTab(pane) {
  return pane?.tabs.find(t => t.id === pane.activeTabId) || null;
}

/** Static (always-available) commands. Some are pane-scoped — gated by
 *  whether the focused pane has the right tab/state. */
function buildStaticCommands() {
  const out = [];
  const pane = focusedPane();
  const tab = activeTab(pane);

  // 1. New conversation
  out.push({
    label: "New conversation",
    subtitle: "Spawn a fresh agent in tmux",
    icon: "plus",
    run: () => document.getElementById("new-conv-btn")?.click(),
  });

  // 2. Resume in tmux
  if (pane && tab && tab.sessionId) {
    out.push({
      label: tab.terminal?.session && !tab.terminal?.detached
        ? "Detach tmux terminal"
        : "Resume in tmux",
      subtitle: tab.sessionId,
      icon: "terminal",
      run: () => toggleTerminal(pane),
    });
  }

  // 3. Search in conversation
  if (pane) {
    out.push({
      label: pane.search?.open ? "Hide pane search bar" : "Search in conversation",
      subtitle: "In-pane find with prev/next",
      icon: "search",
      run: () => toggleSearchBar(pane),
    });
  }

  // 4. Split pane right
  if (pane) {
    out.push({
      label: "Split pane right",
      subtitle: "Side-by-side from focused pane",
      icon: "split-h",
      run: () => splitPane(pane.id, "h"),
    });
  }

  // 5. Split pane down
  if (pane) {
    out.push({
      label: "Split pane down",
      subtitle: "Top / bottom from focused pane",
      icon: "split-v",
      run: () => splitPane(pane.id, "v"),
    });
  }

  // 6+. Remaining in original order
  out.push({
    label: "Save workspace",
    subtitle: "Persist current pane layout",
    icon: "save",
    run: async () => {
      const name = prompt("Save current workspace as:");
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(name.trim())) {
        if (name !== null) toast("Name must be 1–64 chars · letters/digits/space/-/_");
        return;
      }
      try { await saveWorkspaceAs(name.trim()); toast(`Saved "${name.trim()}"`); }
      catch (e) { toast(`Save failed: ${e.message}`); }
    },
  });
  out.push({
    label: "Reset layout",
    subtitle: "Close every pane → single empty pane",
    icon: "square",
    run: () => {
      if (confirm("Reset to a single empty pane? Your tabs will close."))
        resetLayout();
    },
  });
  out.push({
    label: "Refresh sessions",
    subtitle: "Re-scan provider directories",
    icon: "refresh",
    run: () => document.getElementById("refresh-btn")?.click(),
  });
  out.push({
    label: state.groupMode === "project"
      ? "Sidebar: sort by recency"
      : "Sidebar: group by project",
    subtitle: "Toggle session grouping",
    icon: "folder",
    run: () => document.getElementById("group-btn")?.click(),
  });
  out.push({
    label: state.live ? "Live polling: turn off" : "Live polling: turn on",
    subtitle: "Stop / resume tab auto-refresh",
    icon: "dot",
    run: () => document.getElementById("poll-toggle")?.click(),
  });

  if (pane) {
    const canClose = state.workspace.root.type === "split"
                 || state.workspace.root.id !== pane.id;
    if (canClose) {
      out.push({
        label: "Close focused pane",
        subtitle: "Detaches its xterm if any",
        icon: "x",
        run: () => closePane(pane.id),
      });
    }
    if (tab && tab.sessionId) {
      out.push({
        label: "Copy resume command",
        subtitle: tab.provider === "claude"   ? `claude -r ${tab.sessionId}`
               : tab.provider === "codex"    ? `codex resume ${tab.sessionId}`
               : tab.provider === "opencode" ? `opencode -s ${tab.sessionId}`
               : `gemini -r ${tab.sessionId}`,
        icon: "copy",
        run: () => {
          const cmd = tab.provider === "claude"   ? `claude -r ${tab.sessionId}`
                    : tab.provider === "codex"    ? `codex resume ${tab.sessionId}`
                    : tab.provider === "opencode" ? `opencode -s ${tab.sessionId}`
                    : `gemini -r ${tab.sessionId}`;
          navigator.clipboard?.writeText(cmd);
          toast(`Copied: ${cmd}`);
        },
      });
      out.push({
        label: "Open folder in VS Code",
        subtitle: tab.project || "(resolves cwd from session)",
        icon: "code",
        run: () => {
          const paneEl = el.workspace.querySelector(`.pane[data-pane-id="${pane.id}"]`);
          paneEl?.querySelector('[data-action="open-code"]')?.click();
        },
      });
    }
  }

  // Focus other panes when more than one exists.
  if (state.workspace?.root?.type === "split") {
    walkPanes(state.workspace.root, p => {
      if (p.id === state.workspace.focusedPaneId) return;
      const t = activeTab(p);
      out.push({
        label: `Focus pane: ${t?.label || "(empty)"}`,
        subtitle: t?.provider ? PROVIDER_LABEL[t.provider] : "no active tab",
        icon: "pane",
        run: () => focusPane(p.id),
      });
    });
  }

  return out;
}

/** Dynamic items pulled from `state.sessions` and persisted workspaces. We
 *  don't try to score the full message body — sidebar search is the right
 *  tool for that — palette stays fast by sticking to summary / project / id
 *  on already-loaded card data. */
async function buildDynamicCommands(query) {
  const out = [];
  const limit = query ? 30 : 10;
  for (const s of state.sessions.slice(0, 200)) {
    out.push({
      label: s.summary || s.session_id,
      subtitle: `${PROVIDER_LABEL[s.type] || s.type}${s.project ? " · " + shortProject(s.project) : ""}`,
      icon: "msg",
      tag: s.type,
      run: () => {
        const target = state.workspace.focusedPaneId
                    || firstPaneIn(state.workspace.root).id;
        addOrActivateTab(target, s);
      },
    });
    if (out.length >= limit && !query) break;
  }

  // Saved workspaces — only fetched when the palette is actually open.
  try {
    const list = await listSavedWorkspaces();
    for (const w of list) {
      out.push({
        label: `Load workspace: ${w.name}`,
        subtitle: `${w.tabs} tab${w.tabs === 1 ? "" : "s"}`,
        icon: "folder",
        run: async () => {
          if (!confirm(`Load workspace "${w.name}"? Your current panes will be replaced.`)) return;
          try { await loadWorkspace(w.name); }
          catch (e) { toast(`Load failed: ${e.message}`); }
        },
      });
      out.push({
        label: `Delete workspace: ${w.name}`,
        subtitle: "Cannot be undone",
        icon: "trash",
        run: async () => {
          if (!confirm(`Delete workspace "${w.name}"? This can't be undone.`)) return;
          try { await deleteWorkspace(w.name); toast(`Deleted "${w.name}"`); }
          catch (e) { toast(`Delete failed: ${e.message}`); }
        },
      });
    }
  } catch { /* offline / server down — drop the workspace items */ }

  return out;
}

// ---- scoring + filtering --------------------------------------------------

/** Subsequence match: returns score (lower = better) or -1 if no match.
 *  Score combines starting position + total span + character bonus for
 *  matches near word boundaries. */
function subseqScore(needle, hay) {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (n === h) return 0;
  const idx = h.indexOf(n);
  if (idx >= 0) return 1 + idx; // contiguous match — best
  let hi = 0, score = 0, lastHit = -1, gaps = 0;
  for (const ch of n) {
    let found = -1;
    for (let i = hi; i < h.length; i++) {
      if (h[i] === ch) { found = i; break; }
    }
    if (found < 0) return -1;
    if (lastHit >= 0) gaps += found - lastHit - 1;
    lastHit = found;
    hi = found + 1;
  }
  score = 1000 + gaps * 4 + hi;
  return score;
}

function scoreItem(item, q) {
  if (!q) return 1;
  const inLabel = subseqScore(q, item.label);
  if (inLabel >= 0) return inLabel;
  const inSub = subseqScore(q, item.subtitle || "");
  if (inSub >= 0) return 5000 + inSub;
  return -1;
}

// ---- render ---------------------------------------------------------------

const ICONS = {
  plus:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  save:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>`,
  square:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`,
  folder:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  dot:     `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`,
  "split-h": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/></svg>`,
  "split-v": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="8" rx="1"/><rect x="4" y="13" width="16" height="8" rx="1"/></svg>`,
  x:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  search:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>`,
  terminal:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>`,
  copy:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  code:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  pane:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/></svg>`,
  msg:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  trash:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
};

function renderList() {
  if (currentItems.length === 0) {
    els.list.innerHTML = `<div class="palette-empty">No matches</div>`;
    return;
  }
  cursor = Math.max(0, Math.min(cursor, currentItems.length - 1));
  const frag = document.createDocumentFragment();
  for (let i = 0; i < currentItems.length; i++) {
    const it = currentItems[i];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "palette-item" + (i === cursor ? " active" : "");
    row.dataset.idx = String(i);
    const tagHtml = it.tag ? `<span class="palette-tag provider-${it.tag}">${escapeHtml(PROVIDER_LABEL[it.tag] || it.tag)}</span>` : "";
    row.innerHTML = `
      <span class="palette-item-icon">${ICONS[it.icon] || ICONS.dot}</span>
      <span class="palette-item-body">
        <span class="palette-item-label"></span>
        <span class="palette-item-subtitle"></span>
      </span>
      ${tagHtml}
    `;
    row.querySelector(".palette-item-label").textContent = it.label;
    row.querySelector(".palette-item-subtitle").textContent = it.subtitle || "";
    row.addEventListener("mouseenter", () => {
      cursor = i;
      // Just toggle classes — full re-render would steal scrollTop.
      for (const r of els.list.querySelectorAll(".palette-item.active"))
        r.classList.remove("active");
      row.classList.add("active");
    });
    row.addEventListener("click", () => runAt(i));
    frag.appendChild(row);
  }
  els.list.replaceChildren(frag);
  // Make sure the active row is in view.
  const active = els.list.querySelector(".palette-item.active");
  active?.scrollIntoView({ block: "nearest" });
}

async function rebuild() {
  const q = els.input.value.trim();
  const all = [...buildStaticCommands(), ...await buildDynamicCommands(q)];
  if (!q) {
    currentItems = all;
  } else {
    const scored = [];
    for (const it of all) {
      const s = scoreItem(it, q);
      if (s >= 0) scored.push([s, it]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    currentItems = scored.map(([, it]) => it);
  }
  cursor = 0;
  renderList();
}

function runAt(i) {
  const it = currentItems[i];
  if (!it) return;
  closePalette();
  // Defer so the modal is fully torn down before we run anything that might
  // mutate the workspace (and trigger a re-render that grabs focus back).
  Promise.resolve().then(() => it.run());
}

// ---- open / close ---------------------------------------------------------

function openPalette() {
  if (!els.modal) return;
  els.modal.hidden = false;
  els.input.value = "";
  rebuild();
  requestAnimationFrame(() => els.input.focus());
}

function closePalette() {
  if (!els.modal) return;
  els.modal.hidden = true;
}

function isOpen() { return els.modal && !els.modal.hidden; }

// ---- wiring ---------------------------------------------------------------

if (els.input) {
  els.input.addEventListener("input", () => rebuild());
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(cursor + 1, currentItems.length - 1);
      renderList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });
}

if (els.modal) {
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closePalette();
  });
}

window.addEventListener("keydown", (e) => {
  // Toggle: Ctrl+K or Cmd+K (no other modifiers). Works regardless of focus.
  const k = e.key.toLowerCase();
  if (k === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (isOpen()) closePalette();
    else openPalette();
  }
});
