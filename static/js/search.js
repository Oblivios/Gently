// Per-pane search bar: builds the DOM, walks text nodes, highlights matches
// with <mark class="search-hit"> (+ `.current` on the active one).

import { state, runtime, el } from "./state.js";
import { persistWorkspace } from "./workspace.js";

export function buildSearchBarElement(pane) {
  const rt = runtime.get(pane.id) || (runtime.set(pane.id, {}).get(pane.id));
  const bar = document.createElement("div");
  bar.className = "pane-search-bar";
  bar.dataset.paneSearch = pane.id;
  bar.innerHTML = `
    <div class="pane-search-field">
      <svg class="pane-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" placeholder="Search in conversation…" autocomplete="off" spellcheck="false" />
    </div>
    <span class="pane-search-count" aria-live="polite">0 / 0</span>
    <button class="pane-search-btn" data-action="prev" title="Previous match (Shift+Enter)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
    </button>
    <button class="pane-search-btn" data-action="next" title="Next match (Enter)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <button class="pane-search-btn" data-action="close" title="Close (Esc)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>`;
  const input = bar.querySelector("input");
  const counter = bar.querySelector(".pane-search-count");
  input.value = pane.search?.query || "";
  rt.searchBarEl = bar;
  rt.searchInputEl = input;
  rt.searchCounterEl = counter;
  if (!Array.isArray(rt.searchHits)) rt.searchHits = [];
  if (typeof rt.searchCurrent !== "number") rt.searchCurrent = -1;

  input.addEventListener("input", () => {
    clearTimeout(rt.searchDebounce);
    rt.searchDebounce = setTimeout(() => {
      pane.search.query = input.value;
      runSearch(pane, input.value, { scrollCurrent: true });
      persistWorkspace();
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Flush any pending debounced search first so Enter always acts on
      // the current query.
      if (rt.searchDebounce) {
        clearTimeout(rt.searchDebounce);
        rt.searchDebounce = null;
        if (pane.search.query !== input.value) {
          pane.search.query = input.value;
          runSearch(pane, input.value, { scrollCurrent: true });
          persistWorkspace();
          return;
        }
      }
      if (!rt.searchHits.length) return;
      setSearchCurrent(pane, rt.searchCurrent + (e.shiftKey ? -1 : 1), { scroll: true });
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchBar(pane);
    }
  });
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "prev") setSearchCurrent(pane, rt.searchCurrent - 1, { scroll: true });
    else if (action === "next") setSearchCurrent(pane, rt.searchCurrent + 1, { scroll: true });
    else if (action === "close") closeSearchBar(pane);
  });
  return bar;
}

export function openSearchBar(pane) {
  if (!pane.search) pane.search = { open: false, query: "" };
  pane.search.open = true;
  const paneEl = el.workspace.querySelector(`.pane[data-pane-id="${pane.id}"]`);
  if (!paneEl) return;
  let bar = paneEl.querySelector(":scope > .pane-search-bar");
  if (!bar) {
    bar = buildSearchBarElement(pane);
    const body = paneEl.querySelector(":scope > .pane-body");
    paneEl.insertBefore(bar, body);
  }
  const btn = paneEl.querySelector(`.pane-header [data-action="toggle-search"]`);
  if (btn) { btn.classList.add("active"); btn.setAttribute("aria-pressed", "true"); }
  const rt = runtime.get(pane.id);
  const input = rt?.searchInputEl;
  if (input) requestAnimationFrame(() => { input.focus(); input.select(); });
  if (pane.search.query) runSearch(pane, pane.search.query, { scrollCurrent: true });
  else updateSearchCounter(pane);
  persistWorkspace();
}

export function closeSearchBar(pane) {
  if (!pane.search) pane.search = { open: false, query: "" };
  pane.search.open = false;
  const rt = runtime.get(pane.id);
  if (rt?.bodyEl) clearSearchHighlights(rt.bodyEl);
  if (rt) {
    rt.searchHits = [];
    rt.searchCurrent = -1;
    rt.searchBarEl = null;
    rt.searchInputEl = null;
    rt.searchCounterEl = null;
    if (rt.searchDebounce) { clearTimeout(rt.searchDebounce); rt.searchDebounce = null; }
  }
  const paneEl = el.workspace.querySelector(`.pane[data-pane-id="${pane.id}"]`);
  const bar = paneEl?.querySelector(":scope > .pane-search-bar");
  if (bar) bar.remove();
  const btn = paneEl?.querySelector(`.pane-header [data-action="toggle-search"]`);
  if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); }
  persistWorkspace();
}

export function toggleSearchBar(pane) {
  if (pane.search?.open) closeSearchBar(pane);
  else openSearchBar(pane);
}

export function clearSearchHighlights(body) {
  if (!body) return;
  const marks = body.querySelectorAll("mark.search-hit");
  const parents = new Set();
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

export function runSearch(pane, query, { scrollCurrent = true } = {}) {
  const rt = runtime.get(pane.id);
  if (!rt?.bodyEl) return;
  clearSearchHighlights(rt.bodyEl);
  rt.searchHits = [];
  rt.searchCurrent = -1;

  const q = (query ?? "").toString();
  if (!q) { updateSearchCounter(pane); return; }
  const qLower = q.toLowerCase();

  // Skip <summary> contents and text inside *collapsed* <details>, so only
  // expanded tool/thinking bodies are searchable.
  const walker = document.createTreeWalker(rt.bodyEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !node.parentElement) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent.closest("summary")) return NodeFilter.FILTER_REJECT;
      const details = parent.closest("details");
      if (details && !details.open) return NodeFilter.FILTER_REJECT;
      if (parent.closest("mark.search-hit")) return NodeFilter.FILTER_REJECT;
      return text.toLowerCase().indexOf(qLower) === -1
        ? NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);

  for (const node of targets) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const parent = node.parentNode;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    let lastEnd = 0;
    let idx = lower.indexOf(qLower);
    while (idx !== -1) {
      if (idx > lastEnd) frag.appendChild(document.createTextNode(text.slice(lastEnd, idx)));
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      rt.searchHits.push(mark);
      lastEnd = idx + q.length;
      idx = lower.indexOf(qLower, lastEnd);
    }
    if (lastEnd < text.length) frag.appendChild(document.createTextNode(text.slice(lastEnd)));
    parent.replaceChild(frag, node);
  }

  if (rt.searchHits.length > 0) {
    setSearchCurrent(pane, 0, { scroll: scrollCurrent });
  } else {
    updateSearchCounter(pane);
  }
}

export function setSearchCurrent(pane, idx, { scroll = true } = {}) {
  const rt = runtime.get(pane.id);
  if (!rt?.searchHits) return;
  const n = rt.searchHits.length;
  if (n === 0) { rt.searchCurrent = -1; updateSearchCounter(pane); return; }
  const wrapped = ((idx % n) + n) % n;
  if (rt.searchCurrent >= 0 && rt.searchHits[rt.searchCurrent]) {
    rt.searchHits[rt.searchCurrent].classList.remove("current");
  }
  rt.searchCurrent = wrapped;
  const hit = rt.searchHits[wrapped];
  if (hit) {
    hit.classList.add("current");
    if (scroll) {
      // Open any collapsed <details> ancestors before scrolling so the
      // highlighted mark is actually visible.
      let d = hit.parentElement && hit.parentElement.closest("details");
      while (d) {
        if (!d.open) d.open = true;
        d = d.parentElement && d.parentElement.closest("details");
      }
      hit.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  updateSearchCounter(pane);
}

function updateSearchCounter(pane) {
  const rt = runtime.get(pane.id);
  if (!rt?.searchCounterEl) return;
  const n = rt.searchHits?.length || 0;
  rt.searchCounterEl.textContent = n === 0 ? "0 / 0" : `${rt.searchCurrent + 1} / ${n}`;
}

/** Called after content changes (tab switch, poll append, load-earlier) so
 *  highlights track the new DOM. */
export function maybeRerunSearch(pane, opts = {}) {
  if (!pane.search?.open) return;
  const rt = runtime.get(pane.id);
  if (!rt?.searchInputEl) return;
  const q = rt.searchInputEl.value || pane.search.query || "";
  if (!q) { updateSearchCounter(pane); return; }
  runSearch(pane, q, opts);
}
