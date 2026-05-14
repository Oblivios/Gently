// Sidebar: filter chips, session list, search box, keyboard cursor.

import {
  state, el, api, PROVIDERS, PROVIDER_LABEL,
  persistCollapsed, getLabelOverride, setLabelOverride,
} from "./state.js";
import { escapeHtml, relTime, absTime, shortProject, inlineRename } from "./util.js";
import { addOrActivateTab } from "./render.js";
import { firstPaneIn, walkPanes } from "./workspace.js";

export function applyChipState() {
  for (const c of el.chips) {
    const p = c.dataset.provider;
    const on = state.enabled.has(p);
    c.classList.toggle("active", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

export function updateChipCounts() {
  const counts = { claude: 0, codex: 0, gemini: 0, opencode: 0 };
  for (const s of state.sessions) counts[s.type] = (counts[s.type] || 0) + 1;
  for (const c of el.chips) {
    const p = c.dataset.provider;
    const slot = c.querySelector(".chip-count");
    if (slot) slot.textContent = counts[p] ? String(counts[p]) : "";
  }
}

export function applyFilter() {
  state.filtered = state.sessions.filter(s => state.enabled.has(s.type));
}

export function renderSidebar() {
  el.sessionCount.textContent = state.filtered.length === state.sessions.length
    ? `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`
    : `${state.filtered.length} / ${state.sessions.length}`;

  applyGroupButtonState();

  if (state.filtered.length === 0) {
    el.sessionList.innerHTML = `<div class="empty-sidebar">${
      state.sessions.length === 0 ? "No sessions found." : "No matches."
    }</div>`;
    return;
  }

  if (state.groupMode === "project") {
    el.sessionList.replaceChildren(buildProjectGrouping());
  } else {
    const frag = document.createDocumentFragment();
    for (const s of state.filtered) frag.appendChild(buildSessionCard(s));
    el.sessionList.replaceChildren(frag);
  }
}

function buildSessionCard(s) {
  const card = document.createElement("div");
  card.className = `session-card provider-${s.type}`;
  card.dataset.id = s.session_id;
  card.dataset.provider = s.type;
  card.title = absTime(s.ts);

  const override = getLabelOverride(s.type, s.session_id);
  const displayLabel = override || s.summary || s.session_id;

  card.innerHTML = `
    <div class="session-card-top">
      <span class="dot"></span>
      <span class="provider-badge">${PROVIDER_LABEL[s.type] || s.type}</span>
      <span>${escapeHtml(relTime(s.ts))}</span>
      <span class="count">${s.count ?? ""}</span>
    </div>
    <div class="session-card-summary"></div>
    ${s.project ? `<div class="session-card-project" dir="ltr">${escapeHtml(shortProject(s.project))}</div>` : ""}
  `;
  const summaryEl = card.querySelector(".session-card-summary");
  summaryEl.textContent = displayLabel;

  summaryEl.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    inlineRename(summaryEl, displayLabel, (val) => {
      setLabelOverride(s.type, s.session_id, val);
      // Propagate to any open tabs showing this session.
      if (state.workspace) {
        walkPanes(state.workspace.root, (pane) => {
          for (const tab of pane.tabs) {
            if (tab.sessionId === s.session_id && tab.provider === s.type) {
              tab.label = val;
            }
          }
        });
        import("./workspace.js").then(m => m.persistWorkspace());
        import("./render.js").then(m => {
          if (state.workspace) {
            walkPanes(state.workspace.root, (pane) => m.renderPaneHeader(pane));
          }
        });
      }
    });
  });

  card.addEventListener("click", (e) => {
    if (e.target.closest(".inline-rename")) return;
    const target = state.workspace.focusedPaneId || firstPaneIn(state.workspace.root).id;
    addOrActivateTab(target, s);
  });
  return card;
}

const NO_PROJECT_KEY = "__no_project__";

/** Bucket `state.filtered` by project (cwd). Within each bucket the cards
 *  stay in the same order they came in (already sorted by ts desc), and the
 *  buckets themselves are sorted by their most-recent session — so the
 *  project you used last shows up first. */
function buildProjectGrouping() {
  const buckets = new Map();  // key → { project, sessions, latestTs }
  for (const s of state.filtered) {
    const key = s.project || NO_PROJECT_KEY;
    let b = buckets.get(key);
    if (!b) {
      b = { project: s.project || "", sessions: [], latestTs: 0 };
      buckets.set(key, b);
    }
    b.sessions.push(s);
    if ((s.ts || 0) > b.latestTs) b.latestTs = s.ts || 0;
  }
  const groups = [...buckets.entries()].sort(
    (a, b) => b[1].latestTs - a[1].latestTs,
  );

  const frag = document.createDocumentFragment();
  for (const [key, b] of groups) {
    const collapsed = state.groupCollapsed.has(key);
    const group = document.createElement("div");
    group.className = "project-group" + (collapsed ? " collapsed" : "");
    group.dataset.projectKey = key;

    const header = document.createElement("button");
    header.type = "button";
    header.className = "project-group-header";
    header.innerHTML = `
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      <span class="project-group-name" dir="ltr"></span>
      <span class="project-group-meta"></span>
    `;
    header.querySelector(".project-group-name").textContent =
      b.project ? shortProject(b.project) : "no project";
    header.querySelector(".project-group-meta").textContent =
      `${b.sessions.length} · ${relTime(b.latestTs)}`;
    if (b.project) header.title = b.project;
    header.addEventListener("click", () => toggleGroupCollapsed(key));
    group.appendChild(header);

    const body = document.createElement("div");
    body.className = "project-group-body";
    for (const s of b.sessions) body.appendChild(buildSessionCard(s));
    group.appendChild(body);

    frag.appendChild(group);
  }
  return frag;
}

function toggleGroupCollapsed(key) {
  if (state.groupCollapsed.has(key)) state.groupCollapsed.delete(key);
  else state.groupCollapsed.add(key);
  persistCollapsed();
  renderSidebar();
}

function applyGroupButtonState() {
  if (!el.groupBtn) return;
  const project = state.groupMode === "project";
  el.groupBtn.classList.toggle("group-on", project);
  el.groupBtn.setAttribute("aria-pressed", project ? "true" : "false");
  el.groupBtn.title = project
    ? "Grouped by project · click for recency"
    : "Sorted by recency · click to group by project";
}

export async function fetchSessions(query = "") {
  const q = query.trim();
  const r = await api(`/api/sessions?q=${encodeURIComponent(q)}&providers=${PROVIDERS.join(",")}`);
  state.sessions = r.results || [];
  applyFilter();
  updateChipCounts();
  renderSidebar();
  el.brandSub.textContent = `${state.sessions.length} sessions`;
}

// ---- keyboard cursor (ghost-active card) ----------------------------------

export function updateSidebarCursor(sessionId) {
  state.sidebarCursor = sessionId;
  for (const c of el.sessionList.querySelectorAll(".session-card")) {
    c.classList.toggle("active", c.dataset.id === state.sidebarCursor);
  }
  const active = el.sessionList.querySelector(".session-card.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

export function moveCursor(delta) {
  if (state.filtered.length === 0) return;
  const idx = state.filtered.findIndex(s => s.session_id === state.sidebarCursor);
  const next = idx < 0
    ? (delta > 0 ? 0 : state.filtered.length - 1)
    : Math.max(0, Math.min(state.filtered.length - 1, idx + delta));
  const target = state.filtered[next];
  if (target) updateSidebarCursor(target.session_id);
}

export function openCursor() {
  if (!state.sidebarCursor) return;
  const s = state.filtered.find(x => x.session_id === state.sidebarCursor);
  if (!s) return;
  const target = state.workspace.focusedPaneId || firstPaneIn(state.workspace.root).id;
  addOrActivateTab(target, s);
}
