// "+ New conversation" modal: pick a provider + a working directory, then
// POST /api/tmux/start-new and attach the resulting tmux session to the
// focused pane as an ephemeral tab (no session_id yet — the agent will mint
// one after it's fully booted; that file appears in the sidebar on refresh).

import { state, toast } from "./state.js";
import { uid } from "./util.js";
import { findPane, firstPaneIn, persistWorkspace } from "./workspace.js";
import { renderPane } from "./render.js";

const $ = (id) => document.getElementById(id);

const els = {
  openBtn:    $("new-conv-btn"),
  modal:      $("new-conv-modal"),
  closeBtn:   $("new-conv-close"),
  cancelBtn:  $("new-conv-cancel"),
  startBtn:   $("new-conv-start"),
  providers:  $("new-conv-providers"),
  workdir:    $("new-conv-workdir"),
  bypassRow:  $("new-conv-bypass-row"),
  bypassChk:  $("new-conv-bypass"),
};

let chosenProvider = null;

function setProvider(p) {
  chosenProvider = p;
  for (const b of els.providers.querySelectorAll(".provider-pick")) {
    b.classList.toggle("active", b.dataset.provider === p);
  }
  els.bypassRow.style.display = p === "claude" ? "flex" : "none";
  refreshStartButton();
}

function currentMode() {
  const r = document.querySelector("input[name='new-conv-mode']:checked");
  return r ? r.value : "open";
}

function refreshStartButton() {
  const mode = currentMode();
  const wd = els.workdir.value.trim();
  els.workdir.disabled = mode !== "open";
  const ok = !!chosenProvider && (mode === "temp" || wd.length > 0);
  els.startBtn.disabled = !ok;
}

function openModal() {
  els.modal.hidden = false;
  // Default Claude — most common case, and matches the rest of the UI.
  setProvider("claude");
  els.workdir.value = "";
  els.bypassChk.checked = false;
  // Default to "open"; user types a path and hits Start.
  for (const r of document.querySelectorAll("input[name='new-conv-mode']")) {
    r.checked = r.value === "open";
  }
  refreshStartButton();
  requestAnimationFrame(() => els.workdir.focus());
}

function closeModal() {
  els.modal.hidden = true;
}

async function startConversation() {
  if (els.startBtn.disabled) return;
  const mode = currentMode();
  const provider = chosenProvider;
  const body = { provider, mode };
  if (mode === "open") body.workdir = els.workdir.value.trim();
  if (provider === "claude") body.bypass_permissions = !!els.bypassChk.checked;

  els.startBtn.disabled = true;
  els.startBtn.textContent = "Starting…";
  try {
    const res = await fetch("/api/tmux/start-new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`Start failed: ${data.error || res.statusText}`);
      return;
    }
    attachJobToFocusedPane(provider, data.job);
    closeModal();
  } catch (e) {
    toast(`Start failed: ${e.message}`);
  } finally {
    els.startBtn.textContent = "Start";
    refreshStartButton();
  }
}

function attachJobToFocusedPane(provider, job) {
  const targetId = state.workspace.focusedPaneId
    || firstPaneIn(state.workspace.root).id;
  const pane = findPane(state.workspace.root, targetId);
  if (!pane) return;

  // Synthetic tab — no sessionId yet. `isNew` keeps the loader from trying to
  // GET /api/sessions/<provider>/ which would 404. Once the user closes the
  // terminal, the body shows a placeholder until they refresh the sidebar.
  const wd = job.workdir || "";
  const short = wd ? wd.replace(/^\/home\/[^/]+/, "~").split("/").slice(-2).join("/") : "scratch";
  // Empty sessionId is the discriminator: loader/poller skip on falsy
  // sessionId, controls disable copy/open-code, and renderPaneBody shows
  // a placeholder when the user detaches the terminal.
  const tab = {
    id: uid("tab"),
    sessionId: "",
    provider,
    label: `New ${provider} · ${short}`,
    project: wd,
    loaded: true,
    items: [], start: 0, end: 0, total: 0,
    terminal: { session: job.session, detached: false },
  };
  pane.tabs.push(tab);
  pane.activeTabId = tab.id;
  renderPane(pane);
  persistWorkspace();
}

// ---- wiring ----------------------------------------------------------------

if (els.openBtn) els.openBtn.addEventListener("click", openModal);
if (els.closeBtn) els.closeBtn.addEventListener("click", closeModal);
if (els.cancelBtn) els.cancelBtn.addEventListener("click", closeModal);
if (els.startBtn) els.startBtn.addEventListener("click", startConversation);

if (els.providers) {
  els.providers.addEventListener("click", (e) => {
    const btn = e.target.closest(".provider-pick");
    if (btn) setProvider(btn.dataset.provider);
  });
}

for (const r of document.querySelectorAll("input[name='new-conv-mode']")) {
  r.addEventListener("change", refreshStartButton);
}
if (els.workdir) {
  els.workdir.addEventListener("input", refreshStartButton);
  els.workdir.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); startConversation(); }
  });
}

if (els.modal) {
  // Click outside the .modal box to dismiss.
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });
}
window.addEventListener("keydown", (e) => {
  if (els.modal?.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); closeModal(); }
});
