// Workspace/pane rendering — the DOM layer. Tree-walks `state.workspace.root`
// producing pane sections + split containers, and re-renders in place when a
// single pane changes.

import { state, runtime, el, paneBodyResizeObserver, PROVIDER_LABEL, getLabelOverride } from "./state.js";
import { uid, isNearBottom, copyText, escapeHtml, inlineRename } from "./util.js";
import { toast } from "./state.js";
import {
  walkPanes, findPane, firstPaneIn, findParentSplit, replaceNode,
  makePane, makeSplit, persistWorkspace, disposePaneRuntime, swapPanes,
  activeTabTerminal,
} from "./workspace.js";
import { appendMessagesTo } from "./messages.js";
import { buildMarkdownExport } from "./export.js";
import {
  buildSearchBarElement, toggleSearchBar, maybeRerunSearch,
} from "./search.js";
import {
  mountTerminalInto, toggleTerminal, teardownTerminalRuntime,
} from "./terminal.js";
import { ensureTabLoaded, loadEarlier, loadFull, schedulePaneLoop } from "./loading.js";

// ---- pane ops that mutate the tree + re-render ----------------------------

export function focusPane(paneId) {
  if (!state.workspace || state.workspace.focusedPaneId === paneId) return;
  state.workspace.focusedPaneId = paneId;
  // Only update focus classes in the DOM — no full re-render.
  for (const node of el.workspace.querySelectorAll(".pane")) {
    node.classList.toggle("focused", node.dataset.paneId === paneId);
  }
  persistWorkspace();
}

export function addOrActivateTab(paneId, sessionInfo) {
  const pane = findPane(state.workspace.root, paneId);
  if (!pane) return;
  let tab = pane.tabs.find(t => t.sessionId === sessionInfo.session_id && t.provider === sessionInfo.type);
  if (!tab) {
    const override = getLabelOverride(sessionInfo.type, sessionInfo.session_id);
    tab = {
      id: uid("tab"),
      sessionId: sessionInfo.session_id,
      provider: sessionInfo.type,
      label: override || sessionInfo.summary || sessionInfo.session_id,
      project: sessionInfo.project || "",
      loaded: false, items: [], start: 0, end: 0, total: 0,
    };
    pane.tabs.push(tab);
  }
  pane.activeTabId = tab.id;
  renderPane(pane);
  ensureTabLoaded(pane, tab);
  persistWorkspace();
}

export function activateTab(paneId, tabId) {
  const pane = findPane(state.workspace.root, paneId);
  if (!pane || pane.activeTabId === tabId) return;
  // Save the old tab's scroll position before we blow it away. `null` means
  // "was near the bottom" — preserves intent across pane resizes so we snap
  // to bottom on restore instead of landing mid-history because the pixel
  // offset no longer maps to the same logical position.
  const body = runtime.get(pane.id)?.bodyEl;
  if (body && pane.activeTabId) {
    pane.scrollTopByTabId[pane.activeTabId] =
      isNearBottom(body) ? null : body.scrollTop;
  }
  pane.activeTabId = tabId;
  renderPane(pane);
  const tab = pane.tabs.find(t => t.id === tabId);
  if (tab) ensureTabLoaded(pane, tab);
  persistWorkspace();
}

export function closeTab(paneId, tabId) {
  const pane = findPane(state.workspace.root, paneId);
  if (!pane) return;
  const idx = pane.tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;
  pane.tabs.splice(idx, 1);
  delete pane.scrollTopByTabId[tabId];
  if (pane.activeTabId === tabId) {
    const next = pane.tabs[idx] || pane.tabs[idx - 1] || null;
    pane.activeTabId = next?.id || null;
  }
  renderPane(pane);
  if (pane.activeTabId) {
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (tab) ensureTabLoaded(pane, tab);
  }
  persistWorkspace();
}

export function splitPane(paneId, direction) {
  const pane = findPane(state.workspace.root, paneId);
  if (!pane) return;
  const newPane = makePane();
  const split = makeSplit(direction, pane, newPane, 1); // flex-grow 1 + 1 = 50/50
  replaceNode(pane, split);
  state.workspace.focusedPaneId = newPane.id;
  renderWorkspace();
  persistWorkspace();
}

export function closePane(paneId) {
  // Refuse to close if this is the only pane.
  if (state.workspace.root.type === "pane" && state.workspace.root.id === paneId) return;
  const parentInfo = findParentSplit(state.workspace.root, paneId);
  if (!parentInfo) return;
  const { split, side } = parentInfo;
  const sibling = side === "a" ? split.b : split.a;
  replaceNode(split, sibling);
  disposePaneRuntime(paneId);
  // Focus the first pane inside the sibling subtree.
  state.workspace.focusedPaneId = firstPaneIn(sibling).id;
  renderWorkspace();
  persistWorkspace();
}

export function resetLayout() {
  for (const paneId of [...runtime.keys()]) disposePaneRuntime(paneId);
  state.workspace = { root: makePane(), focusedPaneId: null };
  state.workspace.focusedPaneId = state.workspace.root.id;
  renderWorkspace();
  persistWorkspace();
}

// ---- workspace rendering --------------------------------------------------

export function renderWorkspace() {
  // Snapshot scroll positions before we rebuild the DOM. See activateTab
  // for why we store `null` when near the bottom instead of the raw pixel.
  for (const [paneId, rt] of runtime) {
    const pane = findPane(state.workspace.root, paneId);
    if (pane && pane.activeTabId && rt.bodyEl) {
      pane.scrollTopByTabId[pane.activeTabId] =
        isNearBottom(rt.bodyEl) ? null : rt.bodyEl.scrollTop;
    }
  }

  // Preserve live xterm wrappers across the DOM rebuild. replaceChildren
  // would otherwise wipe them, forcing mountTerminalInto to spawn a fresh
  // Terminal + EventSource for every mounted pane — which is the half-second
  // black-out the user sees when splitting or closing a pane elsewhere in
  // the tree. We detach each wrapper now (keeping the live xterm + SSE
  // alive in memory), let renderNode build the new shell, then reinsert
  // the saved wrapper into the new body.
  //
  // We also null out rt.terminal so the teardown call in renderPaneBody
  // doesn't close the EventSource we're trying to preserve.
  const savedTerms = new Map();
  for (const [paneId, rt] of runtime) {
    const pane = findPane(state.workspace.root, paneId);
    if (!pane) continue;
    const t = activeTabTerminal(pane);
    if (!(t?.session && !t?.detached)) continue;
    if (!rt.terminal || !rt.bodyEl) continue;
    const wrap = rt.bodyEl.querySelector(":scope > .pane-terminal");
    if (!wrap) continue;
    savedTerms.set(paneId, { wrap, terminal: rt.terminal });
    wrap.remove();
    rt.terminal = null;
  }

  el.workspace.replaceChildren(renderNode(state.workspace.root));
  walkPanes(state.workspace.root, pane => {
    const saved = savedTerms.get(pane.id);
    if (saved) {
      // Reattach the live wrapper into the freshly-created body. The new
      // pane element already has scroll listeners, drop targets, etc., so
      // we only need to take over the body's content + rebind the runtime
      // pointer to the still-running term/es/fit.
      const rt = runtime.get(pane.id) || {};
      const body = rt.bodyEl;
      if (body) {
        body.classList.add("has-terminal");
        body.innerHTML = "";
        body.appendChild(saved.wrap);
        rt.terminal = saved.terminal;
        runtime.set(pane.id, rt);
        // The new body may sit in a slot with different dimensions — refit
        // once the layout has settled.
        requestAnimationFrame(() => {
          try { saved.terminal.fit?.fit(); } catch { /* ignore */ }
        });
      } else {
        try { saved.terminal.es?.close(); } catch { /* ignore */ }
        try { saved.terminal.term?.dispose(); } catch { /* ignore */ }
      }
      return;
    }
    renderPaneBody(pane);
    const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (activeTab && !activeTab.loaded) ensureTabLoaded(pane, activeTab);
    else schedulePaneLoop(pane);
  });

  // Drop runtime entries for panes that are no longer in the tree.
  const live = new Set();
  walkPanes(state.workspace.root, p => live.add(p.id));
  for (const paneId of [...runtime.keys()]) {
    if (!live.has(paneId)) disposePaneRuntime(paneId);
  }
}

function renderNode(node) {
  return node.type === "pane" ? renderPaneElement(node) : renderSplitElement(node);
}

function renderSplitElement(split) {
  const root = document.createElement("div");
  root.className = `split split-${split.direction}`;
  root.dataset.splitId = split.id;
  root.style.setProperty("--ratio", String(split.ratio));

  const sideA = document.createElement("div");
  sideA.className = "side a";
  sideA.appendChild(renderNode(split.a));

  const resizer = document.createElement("div");
  resizer.className = "resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", split.direction === "h" ? "vertical" : "horizontal");
  attachResizer(resizer, root, split);

  const sideB = document.createElement("div");
  sideB.className = "side b";
  sideB.appendChild(renderNode(split.b));

  root.append(sideA, resizer, sideB);
  return root;
}

function attachResizer(resizer, splitEl, split) {
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    const rect = splitEl.getBoundingClientRect();
    const isH = split.direction === "h";
    const min = 0.12, max = 1 - min;

    const onMove = (ev) => {
      const pos = isH
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      // Side A gets flex-grow:ratio, side B gets flex-grow:(2-ratio), so their
      // split is proportional to ratio/2. To make the UI feel right: ratio = 2*pos.
      const frac = Math.min(max, Math.max(min, pos));
      const ratio = frac * 2;
      split.ratio = ratio;
      splitEl.style.setProperty("--ratio", String(ratio));
    };
    const onUp = () => {
      resizer.releasePointerCapture(e.pointerId);
      resizer.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistWorkspace();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/** Build the floating "jump to bottom" button and wire it to a body. Returns
 *  the button so the caller can insert it wherever it wants inside the pane.
 *  Visibility is driven by the body's scroll handler (toggles `.hidden`). */
function buildScrollToBottomButton(body) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "scroll-to-bottom hidden";
  btn.title = "Scroll to bottom";
  btn.setAttribute("aria-label", "Scroll to bottom");
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  btn.addEventListener("click", () => {
    // Terminal-mode click jumps xterm to the bottom of its scrollback; in
    // history mode we scroll the pane body. The same button serves both
    // worlds so the affordance is uniform across modes.
    const paneId = body.dataset.paneBody;
    const rt = paneId ? runtime.get(paneId) : null;
    if (rt?.terminal?.term) {
      rt.terminal.term.scrollToBottom();
    } else {
      body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
    }
  });
  return btn;
}

function renderPaneElement(pane) {
  const root = document.createElement("section");
  root.className = "pane" + (pane.id === state.workspace.focusedPaneId ? " focused" : "");
  root.dataset.paneId = pane.id;
  root.addEventListener("pointerdown", () => focusPane(pane.id));

  // ---- drag & drop: this pane is a drop target ---------------------------
  // Drop effect: move. We accept only our own custom MIME, so unrelated
  // drags (files, text) don't show fake drop affordance.
  root.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("text/gently-pane")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (root.classList.contains("dragging")) return;  // don't highlight self
    root.classList.add("drop-target");
  });
  root.addEventListener("dragleave", (e) => {
    // Only drop the highlight when we're leaving the pane entirely, not
    // when we cross into a child element (tab, button, scroll area).
    if (!root.contains(e.relatedTarget)) {
      root.classList.remove("drop-target");
    }
  });
  root.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.types?.includes("text/gently-pane")) return;
    e.preventDefault();
    root.classList.remove("drop-target");
    const srcId = e.dataTransfer.getData("text/gently-pane");
    if (!srcId || srcId === pane.id) return;
    swapPanes(srcId, pane.id);
  });

  root.appendChild(renderPaneHeaderElement(pane));
  if (pane.search?.open) root.appendChild(buildSearchBarElement(pane));
  const body = document.createElement("div");
  body.className = "pane-body";
  body.dataset.paneBody = pane.id;
  const scrollBtn = buildScrollToBottomButton(body);
  body.addEventListener("scroll", () => {
    const nearBottom = isNearBottom(body);
    if (pane.activeTabId) {
      pane.scrollTopByTabId[pane.activeTabId] = nearBottom ? null : body.scrollTop;
    }
    const rt = runtime.get(pane.id);
    if (rt) rt.nearBottom = nearBottom;
    scrollBtn.classList.toggle("hidden", nearBottom);
  });
  root.appendChild(body);
  root.appendChild(scrollBtn);

  const rt = runtime.get(pane.id) || {};
  if (rt.bodyEl && rt.bodyEl !== body) paneBodyResizeObserver.unobserve(rt.bodyEl);
  rt.bodyEl = body;
  rt.scrollBtn = scrollBtn;
  // Conservative default: don't auto-snap until the scroll handler sees a
  // real near-bottom state (set inside renderPaneBody's rAF).
  rt.nearBottom = false;
  runtime.set(pane.id, rt);
  paneBodyResizeObserver.observe(body);

  return root;
}

function renderPaneHeaderElement(pane) {
  const header = document.createElement("header");
  header.className = "pane-header";
  header.dataset.paneHeader = pane.id;
  header.draggable = true;

  // ---- drag source -------------------------------------------------------
  header.addEventListener("dragstart", (e) => {
    // Don't hijack clicks on tabs or control buttons — users who meant to
    // click the close-tab X or a pane-btn should still get the click.
    if (e.target.closest("button") || e.target.closest(".tab")) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/gently-pane", pane.id);
    // Use the header strip as the drag ghost so we don't drag a giant
    // snapshot of the entire pane body.
    try { e.dataTransfer.setDragImage(header, 12, 12); } catch { /* ignore */ }
    const paneEl = header.closest(".pane");
    if (paneEl) paneEl.classList.add("dragging");
  });
  header.addEventListener("dragend", () => {
    const paneEl = header.closest(".pane");
    if (paneEl) paneEl.classList.remove("dragging");
    // Defensive: clear any drop-target highlight that lingered if the drop
    // fell outside the workspace (the target's dragleave wouldn't fire).
    for (const p of el.workspace.querySelectorAll(".pane.drop-target")) {
      p.classList.remove("drop-target");
    }
  });

  const strip = document.createElement("div");
  strip.className = "tab-strip";

  for (const tab of pane.tabs) {
    const tabEl = document.createElement("button");
    tabEl.type = "button";
    tabEl.className = `tab provider-${tab.provider}` + (tab.id === pane.activeTabId ? " active" : "");
    tabEl.dataset.tabId = tab.id;
    tabEl.title = `${PROVIDER_LABEL[tab.provider]} · ${tab.sessionId}`;
    tabEl.innerHTML = `
      <span class="tab-dot" aria-hidden="true"></span>
      <span class="tab-label"></span>
      <button class="tab-close" type="button" aria-label="Close tab">&times;</button>
    `;
    const labelEl = tabEl.querySelector(".tab-label");
    labelEl.textContent = tab.label || tab.sessionId;
    labelEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      inlineRename(labelEl, tab.label || tab.sessionId, (val) => {
        tab.label = val;
        persistWorkspace();
        // Also update sidebar override so the card reflects the new name.
        if (tab.sessionId) {
          import("./state.js").then(m => m.setLabelOverride(tab.provider, tab.sessionId, val));
          import("./sidebar.js").then(m => m.renderSidebar());
        }
      });
    });
    tabEl.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close") || e.target.closest(".inline-rename")) return;
      activateTab(pane.id, tab.id);
    });
    // Middle-click closes the tab. preventDefault on mousedown to suppress
    // the OS autoscroll cursor on Linux/Windows.
    tabEl.addEventListener("mousedown", (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(pane.id, tab.id); }
    });
    tabEl.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    tabEl.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(pane.id, tab.id);
    });
    strip.appendChild(tabEl);
  }

  header.appendChild(strip);
  header.appendChild(renderPaneControls(pane));
  return header;
}

function renderPaneControls(pane) {
  const controls = document.createElement("div");
  controls.className = "pane-controls";

  const canClose = state.workspace.root.type === "split" || state.workspace.root.id !== pane.id;
  const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
  const searchOn = !!pane.search?.open;
  const hasPrompts = !!activeTab && activeTab.loaded;
  const t = activeTab?.terminal;
  const hasSession = !!t?.session;
  // "On" = xterm is currently mounted in the body. A detached session is
  // still alive but the body is showing history (or the placeholder).
  const termOn = hasSession && !t?.detached;
  const canResume = !!activeTab && !!activeTab.sessionId;
  // Button stays enabled as long as there's something to toggle: an alive
  // session (to detach/re-attach), or a resumable conversation (to start).
  const canTerm = canResume || hasSession;
  const termTitle = termOn
    ? "Back to history (keeps tmux running)"
    : hasSession
      ? "Re-attach to tmux"
      : "Resume this conversation in tmux";

  controls.innerHTML = `
    <button class="pane-btn" data-action="prev-prompt" title="Jump to previous user prompt" ${hasPrompts ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
    </button>
    <button class="pane-btn" data-action="next-prompt" title="Jump to next user prompt" ${hasPrompts ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m5 12 7 7 7-7"/></svg>
    </button>
    <button class="pane-btn search-toggle${searchOn ? " active" : ""}" data-action="toggle-search" title="Search in conversation" aria-pressed="${searchOn}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
    </button>
    <button class="pane-btn expand-toggle${pane.expanded ? " active" : ""}" data-action="toggle-expanded" title="${pane.expanded ? "Collapse all tool blocks" : "Expand all tool blocks"}" aria-pressed="${!!pane.expanded}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 9 5-5 5 5"/><path d="m7 15 5 5 5-5"/></svg>
    </button>
    <button class="pane-btn terminal-toggle${termOn ? " active" : ""}" data-action="toggle-terminal" title="${termTitle}" aria-pressed="${termOn}" ${canTerm ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>
    </button>
    <button class="pane-btn open-code" data-action="open-code" title="Open this conversation's folder in VS Code" ${canResume ? "" : "disabled"}>
      <!-- Simple Icons' VS Code glyph (CC0). We color it with the VS Code blue
           so the button reads at a glance even among the other toggles. -->
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 6.93a1 1 0 0 0 0 1.476L3.9 11.71.326 15.015a1 1 0 0 0 0 1.477L1.65 17.706a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 19.81V3.99a1.5 1.5 0 0 0-.85-1.403zm-5.146 14.861L10.826 12l7.178-5.448z"/></svg>
    </button>
    <button class="pane-btn" data-action="copy-resume" title="Copy resume command" ${canResume ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
    </button>
    <button class="pane-btn" data-action="copy-md" title="Copy as Markdown" ${activeTab ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 16V8l4 5 4-5v8"/></svg>
    </button>
    <button class="pane-btn" data-action="split-h" title="Split right (side by side)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/></svg>
    </button>
    <button class="pane-btn" data-action="split-v" title="Split down (top / bottom)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="8" rx="1"/><rect x="4" y="13" width="16" height="8" rx="1"/></svg>
    </button>
    <button class="pane-btn close-pane" data-action="close-pane" title="Close pane" ${canClose ? "" : "disabled"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  `;

  controls.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "split-h") splitPane(pane.id, "h");
    else if (action === "split-v") splitPane(pane.id, "v");
    else if (action === "close-pane") closePane(pane.id);
    else if (action === "toggle-search") toggleSearchBar(pane);
    else if (action === "toggle-terminal") toggleTerminal(pane);
    else if (action === "toggle-expanded") toggleExpanded(pane);
    else if (action === "prev-prompt") jumpToUserPrompt(pane, -1);
    else if (action === "next-prompt") jumpToUserPrompt(pane, +1);
    else if (action === "open-code") openInVSCode(pane);
    else if (action === "copy-resume") {
      const t = pane.tabs.find(x => x.id === pane.activeTabId);
      if (!t) return;
      const cmd = t.provider === "claude"   ? `claude -r ${t.sessionId}`
                : t.provider === "codex"    ? `codex resume ${t.sessionId}`
                : t.provider === "opencode" ? `opencode -s ${t.sessionId}`
                : `gemini -r ${t.sessionId}`;
      copyText(cmd);
      toast(`Copied: ${cmd}`);
    } else if (action === "copy-md") {
      const t = pane.tabs.find(x => x.id === pane.activeTabId);
      if (!t) return;
      copyText(buildMarkdownExport(t));
      toast("Copied as Markdown");
    }
  });
  return controls;
}

/** Force every <details> in the pane body open (or closed) to match
 *  pane.expanded. Safe to call after any DOM change. */
export function applyExpandedState(pane) {
  const rt = runtime.get(pane.id);
  const body = rt?.bodyEl;
  if (!body) return;
  // Terminal view has no <details>; skip when xterm is mounted in the body.
  const t = activeTabTerminal(pane);
  if (t?.session && !t?.detached) return;
  const want = !!pane.expanded;
  for (const d of body.querySelectorAll("details")) {
    if (d.open !== want) d.open = want;
  }
}

function toggleExpanded(pane) {
  pane.expanded = !pane.expanded;
  applyExpandedState(pane);
  // Swap just the button's visual state — cheaper than rebuilding the header.
  const paneEl = el.workspace.querySelector(`.pane[data-pane-id="${pane.id}"]`);
  const btn = paneEl?.querySelector(`[data-action="toggle-expanded"]`);
  if (btn) {
    btn.classList.toggle("active", pane.expanded);
    btn.setAttribute("aria-pressed", pane.expanded ? "true" : "false");
    btn.title = pane.expanded ? "Collapse all tool blocks" : "Expand all tool blocks";
  }
  persistWorkspace();
}

/** Open the conversation's working directory in VS Code on the host. The
 *  backend resolves the cwd (walks the session's own JSONL for Claude/Codex;
 *  Gemini has no reliable mapping and will 404 here). */
async function openInVSCode(pane) {
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  if (!tab) return;
  try {
    const res = await fetch("/api/open-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: tab.provider, session_id: tab.sessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`VS Code: ${data.error || res.statusText}`);
      return;
    }
    toast(`Opened ${data.workdir}`);
  } catch (e) {
    toast(`VS Code: ${e.message}`);
  }
}

/** Scroll to the previous/next .msg.user bubble relative to current viewport. */
function jumpToUserPrompt(pane, direction) {
  const rt = runtime.get(pane.id);
  const body = rt?.bodyEl;
  if (!body) return;
  const prompts = body.querySelectorAll(".msg.user");
  if (!prompts.length) return;

  const bodyTop = body.getBoundingClientRect().top;
  const tol = 4;  // avoids jumping to a prompt already pinned at the top

  let target = null;
  if (direction > 0) {
    for (const p of prompts) {
      if (p.getBoundingClientRect().top - bodyTop > tol) { target = p; break; }
    }
  } else {
    for (let i = prompts.length - 1; i >= 0; i--) {
      if (prompts[i].getBoundingClientRect().top - bodyTop < -tol) { target = prompts[i]; break; }
    }
  }
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Re-render a single pane (header + body) in place. */
export function renderPane(pane) {
  const node = el.workspace.querySelector(`.pane[data-pane-id="${pane.id}"]`);
  if (!node) { renderWorkspace(); return; }
  const oldHeader = node.querySelector(".pane-header");
  const oldBody = node.querySelector(".pane-body");
  const oldSearchBar = node.querySelector(":scope > .pane-search-bar");
  const oldScrollBtn = node.querySelector(":scope > .scroll-to-bottom");
  node.replaceChild(renderPaneHeaderElement(pane), oldHeader);
  if (oldSearchBar) oldSearchBar.remove();
  if (oldScrollBtn) oldScrollBtn.remove();
  const newBody = document.createElement("div");
  newBody.className = "pane-body";
  newBody.dataset.paneBody = pane.id;
  const scrollBtn = buildScrollToBottomButton(newBody);
  newBody.addEventListener("scroll", () => {
    const nearBottom = isNearBottom(newBody);
    if (pane.activeTabId) {
      pane.scrollTopByTabId[pane.activeTabId] = nearBottom ? null : newBody.scrollTop;
    }
    const rt = runtime.get(pane.id);
    if (rt) rt.nearBottom = nearBottom;
    scrollBtn.classList.toggle("hidden", nearBottom);
  });
  node.replaceChild(newBody, oldBody);
  if (pane.search?.open) node.insertBefore(buildSearchBarElement(pane), newBody);
  node.appendChild(scrollBtn);
  const rt = runtime.get(pane.id) || {};
  if (rt.bodyEl && rt.bodyEl !== newBody) paneBodyResizeObserver.unobserve(rt.bodyEl);
  rt.bodyEl = newBody;
  rt.scrollBtn = scrollBtn;
  rt.nearBottom = false;
  // A new body means stale hit refs; reset search runtime pointers.
  rt.searchHits = [];
  rt.searchCurrent = -1;
  runtime.set(pane.id, rt);
  paneBodyResizeObserver.observe(newBody);
  renderPaneBody(pane);
  schedulePaneLoop(pane);
}

/** Re-render the header only (used when the tab label updates after load). */
export function renderPaneHeader(pane) {
  const node = el.workspace.querySelector(`.pane[data-pane-id="${pane.id}"]`);
  if (!node) return;
  const oldHeader = node.querySelector(".pane-header");
  node.replaceChild(renderPaneHeaderElement(pane), oldHeader);
}

/** Rebuild the pane body for its currently active tab (or terminal view). */
export function renderPaneBody(pane) {
  const rt = runtime.get(pane.id);
  const body = rt?.bodyEl;
  if (!body) return;

  // Tear down any prior terminal instance so we don't leak the EventSource /
  // xterm when switching tabs or modes.
  teardownTerminalRuntime(pane);
  body.innerHTML = "";

  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  const tt = tab?.terminal;
  if (tt?.session && !tt?.detached) {
    // Mount the xterm UI directly into the body. The `.has-terminal` class
    // lets our CSS shed the history-view chrome (padding, outer scroll) so
    // the xterm canvas actually fills the pane.
    body.classList.add("has-terminal");
    mountTerminalInto(pane, tt.session, body);
    return;
  }
  body.classList.remove("has-terminal");

  if (tab && !tab.sessionId) {
    // Ephemeral tab from "+ New conversation" with the terminal currently
    // detached. There's no session file yet — the agent only writes one
    // after the first message lands. Tell the user how to find it.
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>
        </div>
        <h2>New ${escapeHtml(PROVIDER_LABEL[tab.provider] || tab.provider)} session</h2>
        <p>Working in <code>${escapeHtml(tab.project || "?")}</code>.</p>
        <p style="color:var(--fg-3);max-width:42ch;">
          Click the terminal button to attach. After the first message,
          refresh the sidebar to find this conversation in the list.
        </p>
      </div>`;
    body.appendChild(empty);
    return;
  }
  if (!tab) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <h2>Pick a conversation</h2>
        <p>Click a session in the sidebar to open it in this pane.</p>
        <div class="shortcuts">
          <div><kbd>/</kbd> search</div>
          <div><kbd>↑</kbd><kbd>↓</kbd> navigate</div>
          <div><kbd>Enter</kbd> open</div>
        </div>
      </div>`;
    body.appendChild(empty);
    return;
  }

  if (!tab.loaded) {
    const loading = document.createElement("div");
    loading.className = "pane-empty";
    loading.innerHTML = `<div style="color:var(--fg-2);">Loading session…</div>`;
    body.appendChild(loading);
    return;
  }

  if (tab._error) {
    const err = document.createElement("div");
    err.className = "pane-empty";
    err.style.color = "var(--danger)";
    err.textContent = `Failed to load: ${tab._error}`;
    body.appendChild(err);
    return;
  }

  if (tab.start > 0) {
    const row = document.createElement("div");
    row.className = "load-earlier-row";

    const btnEarlier = document.createElement("button");
    btnEarlier.className = "load-earlier";
    btnEarlier.textContent = `Load earlier (${tab.start} hidden)`;
    btnEarlier.addEventListener("click", () => loadEarlier(pane, tab));

    const btnFull = document.createElement("button");
    btnFull.className = "load-earlier load-full";
    btnFull.innerHTML = `
      <span>Load full conversation</span>
      <span class="hint">may freeze briefly · ${tab.start} messages</span>
    `;
    btnFull.addEventListener("click", async () => {
      btnEarlier.disabled = true;
      btnFull.disabled = true;
      btnFull.innerHTML = `
        <span>Loading full conversation…</span>
        <span class="hint">rendering ${tab.start} messages</span>
      `;
      // Give the browser a frame to paint the "loading" state before the
      // big synchronous render happens.
      await new Promise(r => requestAnimationFrame(() => r()));
      await loadFull(pane, tab);
    });

    row.append(btnEarlier, btnFull);
    body.appendChild(row);
  }

  appendMessagesTo(body, tab.items, tab.provider);
  // Honor the per-pane "expand all" state so freshly-rendered content doesn't
  // arrive collapsed when the user has opted into always-open.
  applyExpandedState(pane);

  // Restore scroll position (or stick to bottom for fresh opens).
  const saved = pane.scrollTopByTabId[tab.id];
  requestAnimationFrame(() => {
    if (typeof saved === "number") body.scrollTop = saved;
    else body.scrollTop = body.scrollHeight;
    const rt2 = runtime.get(pane.id);
    const nearBottom = isNearBottom(body);
    if (rt2) {
      rt2.nearBottom = nearBottom;
      // The scroll handler normally owns this toggle, but programmatic
      // scroll-restore sometimes doesn't fire a 'scroll' event, leaving
      // the button visible at first paint.
      rt2.scrollBtn?.classList.toggle("hidden", nearBottom);
    }
  });

  // Re-highlight search matches against the new content without fighting the
  // scroll restore above.
  maybeRerunSearch(pane, { scrollCurrent: false });
}
