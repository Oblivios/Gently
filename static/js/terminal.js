// Per-pane tmux-backed terminal. Starts a session via /api/tmux/start, renders
// xterm.js over SSE output, sends keystrokes back via POST /api/tmux/input.

import { runtime, toast } from "./state.js";
import { escapeHtml } from "./util.js";
import { persistWorkspace, walkPanes } from "./workspace.js";
import { renderPane, renderWorkspace } from "./render.js";
import { state } from "./state.js";

/** Terminal state lives on the *active tab* now, so two tabs in the same
 *  pane can each carry their own running tmux session. The pane's xterm
 *  runtime (`runtime[paneId].terminal`) is only ever for whichever tab is
 *  currently active — switching tabs tears down and remounts. */
export async function toggleTerminal(pane) {
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  if (!tab) return;
  if (tab.terminal?.session) {
    // Detach: keep the tmux session reference around so re-clicking the
    // terminal button just remounts xterm against the same session. Used
    // to null out `session` on detach and rely on /api/tmux/start +
    // find_running to reattach — that worked for tabs with a real session
    // file id, but not for ephemeral "new conversation" tabs whose
    // sessionId is empty. Carrying `detached` keeps both flows simple.
    if (tab.terminal.detached) {
      tab.terminal.detached = false;
    } else {
      teardownTerminalRuntime(pane);
      tab.terminal.detached = true;
    }
    renderPane(pane);
    persistWorkspace();
    return;
  }
  // No session yet AND no resumable conversation → user clicked terminal on
  // an ephemeral tab after stopping it. Nothing to attach to.
  if (!tab.sessionId) return;

  // Claude-only: ask the user whether they want `--dangerously-skip-permissions`
  // on this resume. `confirm()` defaults to OK=true on Enter, so pressing
  // Enter is "Yes, bypass on" — what the user said they wanted.
  let bypassPermissions = false;
  if (tab.provider === "claude") {
    bypassPermissions = confirm(
      "Do you want to turn bypass permissions on?\n\n" +
      "OK (Enter) = Yes, resume with --dangerously-skip-permissions\n" +
      "Cancel     = No, prompt for every tool as usual"
    );
  }

  try {
    const res = await fetch("/api/tmux/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: tab.provider,
        session_id: tab.sessionId,
        bypass_permissions: bypassPermissions,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(`tmux: ${err.error || res.statusText}`);
      return;
    }
    const data = await res.json();
    tab.terminal = { session: data.job?.session || null, detached: false };
    if (!tab.terminal.session) {
      toast("tmux: no session returned");
      return;
    }
    renderPane(pane);
    persistWorkspace();
  } catch (e) {
    toast(`tmux: ${e.message}`);
  }
}

export async function stopTerminal(pane) {
  const tab = pane.tabs.find(t => t.id === pane.activeTabId);
  const session = tab?.terminal?.session;
  if (!session) return;
  if (!confirm("Kill this tmux session? The agent will be terminated.")) return;
  try {
    await fetch("/api/tmux/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    });
  } catch { /* swallow */ }
  teardownTerminalRuntime(pane);
  tab.terminal = { session: null, detached: false };
  renderPane(pane);
  persistWorkspace();
}

export function teardownTerminalRuntime(pane) {
  const rt = runtime.get(pane.id);
  if (!rt?.terminal) return;
  try { rt.terminal.scrollDisposable?.dispose(); } catch { /* ignore */ }
  try {
    if (rt.terminal.viewportEl && rt.terminal.onViewportScroll) {
      rt.terminal.viewportEl.removeEventListener("scroll", rt.terminal.onViewportScroll);
    }
  } catch { /* ignore */ }
  try { rt.terminal.es?.close(); } catch { /* ignore */ }
  try { rt.terminal.term?.dispose(); } catch { /* ignore */ }
  if (rt.terminal.resizeTimer) clearTimeout(rt.terminal.resizeTimer);
  rt.terminal = null;
}

/** Build the terminal UI AND attach it to `body`, then open xterm.
 *
 *  The attach-before-open ordering matters: xterm reads its parent's computed
 *  dimensions the moment `term.open(host)` runs, and if the host is still
 *  detached those come back as zero and the terminal locks in at a tiny size
 *  even though a later FitAddon.fit() technically resizes it — the initial
 *  canvas allocation is already wrong. Mounting first gives xterm a real
 *  rectangle from the start.
 */
export function mountTerminalInto(pane, session, body) {
  const wrap = document.createElement("div");
  wrap.className = "pane-terminal";

  const toolbar = document.createElement("div");
  toolbar.className = "pane-terminal-toolbar";
  toolbar.innerHTML = `
    <button class="pane-terminal-btn" data-action="detach" title="Back to history (keeps tmux running)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      <span>History</span>
    </button>
    <span class="pane-terminal-status">
      <span class="pane-terminal-dot"></span>
      <span class="pane-terminal-name" title="${escapeHtml(session)}"></span>
    </span>
    <button class="pane-terminal-btn danger" data-action="stop" title="Kill the tmux session">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
      <span>Stop</span>
    </button>`;
  toolbar.querySelector(".pane-terminal-name").textContent = session;
  wrap.appendChild(toolbar);

  const host = document.createElement("div");
  host.className = "pane-terminal-host";
  wrap.appendChild(host);

  // Attach NOW so term.open sees a live host with real dimensions.
  body.appendChild(wrap);

  if (typeof Terminal === "undefined") {
    host.textContent = "xterm.js failed to load — check your network connection.";
    host.style.padding = "16px";
    host.style.color = "var(--fg-2)";
    return wrap;
  }

  // Match Gently's dark blue palette so the terminal feels native, not like
  // a pasted-in black xterm.
  const term = new Terminal({
    cursorBlink: true,
    convertEol: true,
    scrollback: 10000,
    fontSize: 13,
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: {
      background: "#0a0e18",
      foreground: "#e5ecf7",
      cursor: "#3b82f6",
      selectionBackground: "rgba(59, 130, 246, 0.35)",
      black: "#0f1422",
      brightBlack: "#505a74",
    },
  });

  let fit = null;
  try {
    if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
    }
  } catch { /* ignore */ }

  term.open(host);
  // Fit once flex layout has settled. Browsers sometimes report a zero-height
  // host on the first rAF, so we retry on a later tick as a belt-and-braces.
  const doFit = () => { try { fit?.fit(); } catch { /* ignore */ } };
  requestAnimationFrame(doFit);
  setTimeout(doFit, 60);

  // Keep tmux's internal window size in sync with xterm's measured cols/rows.
  // tmux is created at generous defaults (220×60) so the first paint isn't
  // an 80×24 postage stamp, and after FitAddon does its thing we tell tmux
  // the real numbers. Debounced because xterm fires onResize for every
  // intermediate frame during a pane drag.
  const pushResize = (cols, rows) => {
    if (!cols || !rows) return;
    const rt = runtime.get(pane.id);
    if (rt?.terminal?.resizeTimer) clearTimeout(rt.terminal.resizeTimer);
    const timer = setTimeout(() => {
      fetch("/api/tmux/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, cols, rows }),
      }).catch(() => { /* swallow */ });
    }, 80);
    if (rt?.terminal) rt.terminal.resizeTimer = timer;
  };
  term.onResize(({ cols, rows }) => pushResize(cols, rows));
  // Also push a resize after the initial fit, because term.onResize only
  // fires when the dimensions *change* — if xterm happens to initialise at
  // whatever fit() wants, onResize never emits.
  setTimeout(() => pushResize(term.cols, term.rows), 120);

  const es = new EventSource(`/api/tmux/stream?session=${encodeURIComponent(session)}&offset=0`);
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.done) {
        term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
        try { es.close(); } catch { /* ignore */ }
        return;
      }
      if (msg.data) {
        // Base64 → bytes → utf-8, so ANSI escapes & non-utf8 bytes survive.
        const raw = atob(msg.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        term.write(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
      }
    } catch { /* ignore malformed frame */ }
  };
  es.onerror = () => {
    // EventSource will auto-retry; no teardown here.
  };

  // Keystrokes go through a single in-flight POST: anything typed while a
  // previous request is still on the wire gets coalesced into the next
  // body, so a fast typist generates one request per round-trip instead
  // of one per character. This also pins ordering — concurrent fetches
  // could otherwise reach the server on different threads and have their
  // `tmux send-keys` calls interleave.
  let inputBuffer = "";
  let inputInFlight = false;
  const flushInput = () => {
    if (inputInFlight || !inputBuffer) return;
    const text = inputBuffer;
    inputBuffer = "";
    inputInFlight = true;
    fetch("/api/tmux/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, text }),
    })
      .catch(() => { /* swallow */ })
      .finally(() => {
        inputInFlight = false;
        if (inputBuffer) flushInput();
      });
  };
  term.onData((data) => {
    // Drop device-attributes replies like ESC[?1;2c so they don't get typed
    // into the shell as literal "1;2c".
    if (/^\x1b\[[0-9;?]*c$/.test(data)) return;
    inputBuffer += data;
    flushInput();
  });

  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "detach") toggleTerminal(pane);
    else if (btn.dataset.action === "stop") stopTerminal(pane);
  });

  // Drive the pane's existing .scroll-to-bottom button off xterm's viewport
  // position so the same affordance works in both history and terminal mode.
  // We listen on the .xterm-viewport DOM element directly (more reliable than
  // term.onScroll, which doesn't always fire for native wheel scrolls), and
  // also subscribe to term.onScroll so new-content emissions update the
  // button when the user is parked above the bottom.
  let viewportEl = null;
  const syncScrollBtn = () => {
    const rtNow = runtime.get(pane.id);
    const btn = rtNow?.scrollBtn;
    if (!btn) return;
    // Prefer the DOM viewport (cheap, reliable) — fall back to xterm's buffer
    // state during the brief window before .xterm-viewport is queryable.
    let nearBottom;
    const vp = viewportEl;
    if (vp && vp.scrollHeight > vp.clientHeight) {
      nearBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight <= 4;
    } else {
      const buf = term.buffer.active;
      nearBottom = (buf.baseY - buf.viewportY) <= 1;
    }
    btn.classList.toggle("hidden", nearBottom);
  };
  const onViewportScroll = () => syncScrollBtn();
  // .xterm-viewport is created synchronously by term.open(host). Native wheel
  // scrolls hit this element and fire its scroll event — term.onScroll is
  // suppressed for those in xterm v5, so this listener is what catches the
  // user scrolling up. term.onScroll still fires for new-content emissions,
  // which is enough to keep the button accurate when the user is parked.
  viewportEl = host.querySelector(".xterm-viewport");
  if (viewportEl) viewportEl.addEventListener("scroll", onViewportScroll, { passive: true });
  const scrollDisposable = term.onScroll(syncScrollBtn);
  // Run once now and again after the initial fit settles the viewport size.
  syncScrollBtn();
  setTimeout(syncScrollBtn, 120);

  const rt = runtime.get(pane.id) || {};
  rt.terminal = { term, es, fit, scrollDisposable, viewportEl, onViewportScroll };
  runtime.set(pane.id, rt);

  return wrap;
}

/** Drop persisted terminal sessions that the server no longer has, so a reload
 *  doesn't leave dead sessions pinned in the UI. Walks every tab on every
 *  pane since terminal state is per-tab now. */
export async function reconcileTerminalSessions() {
  const live = new Set();
  walkPanes(state.workspace.root, (pane) => {
    for (const tab of pane.tabs) {
      if (tab.terminal?.session) live.add(tab.terminal.session);
    }
  });
  if (live.size === 0) return;
  try {
    const r = await fetch("/api/tmux/jobs");
    if (!r.ok) return;
    const data = await r.json();
    const alive = new Set(
      (data.jobs || [])
        .filter(j => j.status === "running")
        .map(j => j.session)
    );
    let changed = false;
    walkPanes(state.workspace.root, (pane) => {
      for (const tab of pane.tabs) {
        const s = tab.terminal?.session;
        if (s && !alive.has(s)) {
          tab.terminal = { session: null, detached: false };
          changed = true;
        }
      }
    });
    if (changed) {
      renderWorkspace();
      persistWorkspace();
    }
  } catch { /* offline / server down — leave state as-is */ }
}
