// Remote access control — fetches the caller's access level from the server
// and applies appropriate UI restrictions.
//
// Levels:
//   owner     — localhost, full access (default behaviour)
//   trust     — remote, full access (--trust flag)
//   view-all  — remote, browse all sessions, read-only
//   view-only — remote, see only owner's currently-open sessions, read-only

import { state } from "./state.js";
import { walkPanes } from "./workspace.js";

// ---- level helpers ----------------------------------------------------------

export function isReadOnly() {
  return state.accessLevel === "view-only" || state.accessLevel === "view-all";
}

export function isViewOnly() {
  return state.accessLevel === "view-only";
}

// ---- boot: fetch level from server ------------------------------------------

export async function fetchAccessLevel() {
  try {
    const r = await fetch("/api/access", { cache: "no-store" });
    const j = await r.json();
    state.accessLevel = j.level || "trust";
  } catch {
    state.accessLevel = "trust";
  }
}

// ---- apply UI restrictions --------------------------------------------------

export function applyAccessRestrictions() {
  const level = state.accessLevel;
  if (level === "owner" || level === "trust") return;

  // Both read-only levels
  document.body.classList.add("access-readonly");
  if (level === "view-only") {
    document.body.classList.add("access-viewonly");
  }

  // Show the banner
  const banner = document.getElementById("access-banner");
  if (banner) {
    banner.hidden = false;
    const host = window.location.hostname;
    const label = level === "view-only"
      ? `View only · watching ${host}`
      : `Read only · browsing ${host}`;
    const textEl = banner.querySelector(".access-banner-text");
    if (textEl) textEl.textContent = label;
  }
}

// ---- owner: push shared view to server (debounced) --------------------------

let _syncTimer = null;

export function scheduleSyncSharedView() {
  if (state.accessLevel !== "owner") return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(_doSync, 1500);
}

function _doSync() {
  if (!state.workspace) return;

  const seen = new Set();
  const sessions = [];

  walkPanes(state.workspace.root, pane => {
    for (const tab of pane.tabs) {
      if (!tab.sessionId || !tab.provider) continue;
      const key = `${tab.provider}:${tab.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Try to find full metadata (summary, ts, etc.) from the current list.
      const meta = state.sessions.find(
        s => s.session_id === tab.sessionId && s.type === tab.provider,
      );
      sessions.push(meta || {
        session_id: tab.sessionId,
        type: tab.provider,
        summary: tab.label || tab.sessionId,
        ts: 0,
        count: 0,
      });
    }
  });

  fetch("/api/shared-view", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions }),
    cache: "no-store",
  }).catch(() => {});
}
