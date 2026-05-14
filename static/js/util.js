// Small, pure helpers used everywhere. No DOM, no state, no imports.

export const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export function escapeHtml(s) {
  return (s ?? "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function md(text) {
  const raw = (text ?? "").toString();
  if (!window.marked || !window.DOMPurify) return `<pre>${escapeHtml(raw)}</pre>`;
  return DOMPurify.sanitize(marked.parse(raw));
}

export function fenced(text, lang = "text") {
  const clean = (text ?? "").toString();
  // Count the longest existing backtick run so our fence is unambiguously longer.
  const fences = clean.match(/`{3,}/g) || [];
  let n = 3; for (const f of fences) if (f.length >= n) n = f.length + 1;
  return `${"`".repeat(n)}${lang}\n${clean}\n${"`".repeat(n)}`;
}

export function relTime(sec) {
  if (!sec) return "";
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86_400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(sec * 1000);
  const y = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()} `;
  return `${y}${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function absTime(sec) {
  return sec ? new Date(sec * 1000).toLocaleString() : "";
}

export function shortProject(path) {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fb(text));
  } else {
    fb(text);
  }
  function fb(t) {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }
}

/** Replace `labelEl`'s text with an inline <input>. Calls `onCommit(newValue)`
 *  on Enter/blur with a non-empty trimmed value; restores original on Escape
 *  or if the value is blank. The element is left as-is until commit or cancel. */
export function inlineRename(labelEl, initial, onCommit) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = initial;
  input.className = "inline-rename";
  // Approximate the label's rendered width so the input doesn't collapse.
  input.style.width = Math.max(60, initial.length * 7.5) + "px";
  labelEl.replaceWith(input);
  input.select();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const val = input.value.trim();
    input.replaceWith(labelEl);
    if (val && val !== initial) {
      labelEl.textContent = val;
      onCommit(val);
    }
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    input.replaceWith(labelEl);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation(); // don't trigger global keyboard shortcuts while typing
  });
}

export function isNearBottom(elem, threshold = 140) {
  return elem.scrollHeight - elem.scrollTop - elem.clientHeight <= threshold;
}

export function looksJson(s) {
  const t = (s || "").trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

export function coerceTsSeconds(v) {
  if (typeof v === "number") return v > 1e10 ? v / 1000 : v;
  if (typeof v === "string" && v) {
    const ts = Date.parse(v);
    return Number.isFinite(ts) ? ts / 1000 : 0;
  }
  return 0;
}
