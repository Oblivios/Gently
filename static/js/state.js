// Shared state (data + DOM refs + localStorage keys). Every module imports
// `state` / `runtime` / `el` from here so we have a single source of truth.

export const PROVIDERS = ["claude", "codex", "gemini", "opencode"];
export const PROVIDER_LABEL = {
  claude:   "Claude",
  codex:    "Codex",
  gemini:   "Gemini",
  opencode: "OpenCode",
};
export const POLL_MS = 8000;
export const INITIAL_WINDOW = 500;
export const EARLIER_WINDOW = 500;

export const LS_FILTER = "gently.providers";
export const LS_LIVE = "gently.live";
export const LS_WORKSPACE = "gently.workspace.v1";
export const LS_SIDEBAR_W = "gently.sidebar.w";
export const LS_GROUP_MODE = "gently.sidebar.group";  // "recency" | "project"
export const LS_GROUP_COLLAPSED = "gently.sidebar.group.collapsed";
export const LS_LABEL_OVERRIDES = "gently.label-overrides";  // { "provider:sid": label }

// One-time migration from the old `agent-history.*` keys so existing
// tabs/layout/sidebar width survive the rename.
(function migrateLegacyKeys() {
  const map = {
    "agent-history.providers":    LS_FILTER,
    "agent-history.live":         LS_LIVE,
    "agent-history.workspace.v1": LS_WORKSPACE,
    "agent-history.sidebar.w":    LS_SIDEBAR_W,
  };
  for (const [oldKey, newKey] of Object.entries(map)) {
    if (localStorage.getItem(newKey) !== null) continue;
    const v = localStorage.getItem(oldKey);
    if (v !== null) {
      localStorage.setItem(newKey, v);
      localStorage.removeItem(oldKey);
    }
  }
})();

// Sidebar width bounds — min keeps a tiny strip of the sidebar + resizer
// visible so the user can always grab it back.
export const SIDEBAR_MIN = 120;
export const SIDEBAR_MAX = 700;
export const SIDEBAR_DEFAULT = 340;

function restoreEnabled() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_FILTER) || "null");
    if (Array.isArray(saved) && saved.every(p => PROVIDERS.includes(p))) return new Set(saved);
  } catch { /* ignore */ }
  return new Set(PROVIDERS);
}

export function persistEnabled() {
  localStorage.setItem(LS_FILTER, JSON.stringify([...state.enabled]));
}

function restoreLive() {
  const v = localStorage.getItem(LS_LIVE);
  return v === null ? true : v === "true";
}

function restoreLabelOverrides() {
  try {
    const v = localStorage.getItem(LS_LABEL_OVERRIDES);
    const obj = v ? JSON.parse(v) : {};
    return typeof obj === "object" && obj !== null ? obj : {};
  } catch { return {}; }
}

export function getLabelOverride(provider, sessionId) {
  return state.labelOverrides[`${provider}:${sessionId}`] || null;
}

export function setLabelOverride(provider, sessionId, label) {
  const key = `${provider}:${sessionId}`;
  if (label) state.labelOverrides[key] = label;
  else delete state.labelOverrides[key];
  try {
    localStorage.setItem(LS_LABEL_OVERRIDES, JSON.stringify(state.labelOverrides));
  } catch { /* quota */ }
}

function restoreGroupMode() {
  const v = localStorage.getItem(LS_GROUP_MODE);
  return v === "project" ? "project" : "recency";
}

function restoreCollapsed() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_GROUP_COLLAPSED) || "[]");
    return new Set(Array.isArray(arr) ? arr.filter(s => typeof s === "string") : []);
  } catch { return new Set(); }
}

export function persistCollapsed() {
  localStorage.setItem(LS_GROUP_COLLAPSED, JSON.stringify([...state.groupCollapsed]));
}

export const state = {
  sessions: [],
  filtered: [],
  query: "",
  enabled: restoreEnabled(),
  live: restoreLive(),
  workspace: null,      // { root: Node, focusedPaneId: string }
  loadSeq: 0,
  sidebarCursor: null,  // sidebar keyboard cursor (which card Enter opens)
  groupMode: restoreGroupMode(),       // "recency" | "project"
  groupCollapsed: restoreCollapsed(),  // Set<projectKey> — collapsed groups
  labelOverrides: restoreLabelOverrides(), // { "provider:sid": custom label }
};

// Transient per-pane runtime state — timers, DOM refs, xterm/EventSource
// handles. Deliberately NOT persisted.
export const runtime = new Map();

// DOM refs. Populated once at boot; modules read `el.*` as needed.
export const el = {
  search:         document.getElementById("search"),
  sessionList:    document.getElementById("session-list"),
  sessionCount:   document.getElementById("session-count"),
  brandSub:       document.getElementById("brand-sub"),
  refreshBtn:     document.getElementById("refresh-btn"),
  resetLayoutBtn: document.getElementById("reset-layout-btn"),
  pollToggle:     document.getElementById("poll-toggle"),
  workspace:      document.getElementById("workspace"),
  toast:          document.getElementById("toast"),
  chips:          document.querySelectorAll(".chip[data-provider]"),
  sidebarResizer: document.getElementById("sidebar-resizer"),
  workspacesBtn:     document.getElementById("workspaces-btn"),
  workspacesPopover: document.getElementById("workspaces-popover"),
  workspacesList:    document.getElementById("workspaces-list"),
  workspacesClose:   document.getElementById("workspaces-close"),
  workspacesSave:    document.getElementById("workspaces-save"),
  workspacesSaveName:document.getElementById("workspaces-save-name"),
  groupBtn:          document.getElementById("group-btn"),
};

// Restore sidebar width before first paint.
(function restoreSidebarWidth() {
  const raw = parseInt(localStorage.getItem(LS_SIDEBAR_W) || "", 10);
  const w = Number.isFinite(raw)
    ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, raw))
    : SIDEBAR_DEFAULT;
  document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
})();

// Configure `marked` once, on first import.
if (window.marked) {
  marked.setOptions({
    breaks: false, gfm: true,
    highlight: (code, lang) => {
      if (window.hljs && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch { /* ignore */ }
      }
      return window.hljs ? hljs.highlightAuto(code).value : code;
    },
  });
}

// ---- api + toast -----------------------------------------------------------

export async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

let toastTimer = null;
export function toast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1800);
}

// Shared observer: when a pane-body resizes (window resize, split drag,
// sidebar drag), if we were near the bottom, re-stick to the bottom so
// small layout shifts don't leave a gap beneath the last message. When
// the pane is in terminal mode, we refit xterm instead.
export const paneBodyResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const paneId = entry.target.dataset.paneBody;
    if (!paneId) continue;
    const rt = runtime.get(paneId);
    if (!rt || rt.bodyEl !== entry.target) continue;
    if (rt.terminal?.fit) {
      try { rt.terminal.fit.fit(); } catch { /* ignore */ }
      continue;
    }
    if (rt.nearBottom) entry.target.scrollTop = entry.target.scrollHeight;
  }
});
