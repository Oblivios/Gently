// Message bubble rendering — tool call / result / thinking / plain text.
// Consumes the structured objects produced by `parsers.js`.

import { escapeHtml, md, fenced, looksJson, relTime, absTime, copyText } from "./util.js";
import { parserFor } from "./parsers.js";

export function appendMessagesTo(body, items, provider) {
  body.appendChild(renderMessages(items, provider));
}

export function renderMessages(items, provider) {
  const frag = document.createDocumentFragment();
  const renderEntry = parserFor(provider);
  let lastSig = "";
  for (const entry of items) {
    const out = renderEntry(entry);
    if (!out) continue;
    // Parsers may return either a single rendered bubble or an array of them
    // (opencode messages get split into one assistant bubble + N tool bubbles).
    const list = Array.isArray(out) ? out : [out];
    for (const r of list) {
      if (!r) continue;
      const sig = `${r.role}::${r.sig ?? ""}`;
      if (sig === lastSig && !r.force) continue;
      lastSig = sig;
      frag.appendChild(buildMessageNode(r));
    }
  }
  return frag;
}

export function buildMessageNode(rendered) {
  const { role, parts, time } = rendered;
  const msg = document.createElement("article");
  msg.className = `msg ${role}`;
  const head = document.createElement("div");
  head.className = "msg-head";
  head.innerHTML = `
    <span class="dot"></span>
    <span>${role}</span>
    ${time ? `<span class="time" title="${escapeHtml(absTime(time))}">${escapeHtml(relTime(time))}</span>` : ""}
  `;
  msg.appendChild(head);
  const body = document.createElement("div");
  body.className = "msg-body";
  if (role === "tool") {
    for (const p of parts) body.appendChild(renderToolResult(p));
    msg.appendChild(body);
    return msg;
  }
  if (role === "user" || role === "assistant") {
    // Absolute-positioned overlay anchored to the bubble's top-left.
    body.appendChild(buildCopyButton(parts));
  }
  const innerMd = document.createElement("div");
  innerMd.className = "md";
  let hasMd = false;
  for (const p of parts) {
    if (p.kind === "text") {
      const wrap = document.createElement("div");
      wrap.innerHTML = p.html;
      while (wrap.firstChild) innerMd.appendChild(wrap.firstChild);
      hasMd = true;
    } else if (p.kind === "tool_call") {
      if (hasMd) { body.appendChild(innerMd.cloneNode(true)); innerMd.innerHTML = ""; hasMd = false; }
      body.appendChild(renderToolCall(p));
    } else if (p.kind === "thinking") {
      if (hasMd) { body.appendChild(innerMd.cloneNode(true)); innerMd.innerHTML = ""; hasMd = false; }
      body.appendChild(renderThinking(p));
    } else if (p.kind === "image") {
      if (hasMd) { body.appendChild(innerMd.cloneNode(true)); innerMd.innerHTML = ""; hasMd = false; }
      body.appendChild(renderImage(p));
    }
  }
  if (hasMd) body.appendChild(innerMd);
  // After the body is fully built, upgrade any inline <img> tags (from
  // markdown image syntax) so they share the thumbnail styling and lightbox
  // click behaviour with explicit image parts.
  for (const img of body.querySelectorAll("img:not(.msg-img)")) {
    decorateMessageImage(img);
  }
  msg.appendChild(body);
  return msg;
}

function renderImage(p) {
  const img = document.createElement("img");
  img.src = p.src;
  img.alt = p.alt || "image";
  decorateMessageImage(img);
  return img;
}

function decorateMessageImage(img) {
  img.classList.add("msg-img");
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    openImageLightbox(img.src, img.alt);
  });
}

function renderToolCall(p) {
  const details = document.createElement("details");
  details.className = "tool";
  let inputStr = "";
  try { inputStr = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}, null, 2); }
  catch { inputStr = String(p.input); }
  const preview = inputStr.replace(/\s+/g, " ").slice(0, 120);
  const summary = document.createElement("summary");
  summary.innerHTML = `
    <div class="tool-row">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      <span class="tool-tag">tool</span>
      <span class="tool-name">${escapeHtml(p.name || "tool")}</span>
      <span class="tool-arg">${escapeHtml(preview)}</span>
    </div>`;
  details.appendChild(summary);
  const wrap = document.createElement("div");
  wrap.className = "tool-body md";
  const lang = looksJson(inputStr) ? "json" : "text";
  wrap.innerHTML = md(fenced(inputStr, lang));
  details.appendChild(wrap);
  return details;
}

function renderToolResult(p) {
  const details = document.createElement("details");
  details.className = "tool";
  const label = p.label || (p.diff ? "diff" : "result");
  const preview = (p.content || "").replace(/\s+/g, " ").slice(0, 120);
  const summary = document.createElement("summary");
  summary.innerHTML = `
    <div class="tool-row">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      <span class="tool-tag">${escapeHtml(label)}</span>
      <span class="tool-arg">${escapeHtml(preview || "—")}</span>
    </div>`;
  details.appendChild(summary);
  const wrap = document.createElement("div");
  wrap.className = "tool-body md";
  wrap.innerHTML = p.diff ? md(fenced(p.diff, "diff")) : md(fenced(p.content || "<no output>"));
  details.appendChild(wrap);
  return details;
}

function buildCopyButton(parts) {
  // Resolve the copy payload eagerly: text parts already carry rendered HTML,
  // so we strip it to textContent now (same trick `buildMarkdownExport` uses).
  // Tool / thinking parts are deliberately excluded — the button copies what
  // the user actually wrote or what the assistant said in prose.
  const pieces = [];
  for (const p of parts) {
    if (p.kind !== "text") continue;
    const tmp = document.createElement("div");
    tmp.innerHTML = p.html;
    const text = tmp.textContent.trim();
    if (text) pieces.push(text);
  }
  const payload = pieces.join("\n\n");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy";
  btn.title = "Copy message";
  btn.setAttribute("aria-label", "Copy message");
  btn.innerHTML = `
    <svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
    <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7.5"/></svg>
  `;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!payload) return;
    copyText(payload);
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1200);
  });
  if (!payload) btn.disabled = true;
  return btn;
}

function renderThinking(p) {
  const details = document.createElement("details");
  details.className = "thinking";
  const summary = document.createElement("summary");
  summary.innerHTML = `
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
    <span>${escapeHtml(p.label || "Thinking…")}</span>`;
  details.appendChild(summary);
  const body = document.createElement("div");
  body.className = "thinking-body md";
  body.innerHTML = md(p.text);
  details.appendChild(body);
  return details;
}

// ---- Image lightbox -------------------------------------------------------
// One global overlay reused for every image click. Built lazily so the DOM
// doesn't carry an empty modal until the first image is opened.

let lightboxEl = null;

function openImageLightbox(src, alt) {
  if (!src) return;
  if (!lightboxEl) buildLightbox();
  const img = lightboxEl.querySelector(".lightbox-img");
  img.src = src;
  img.alt = alt || "";
  lightboxEl.hidden = false;
}

function closeImageLightbox() {
  if (!lightboxEl) return;
  lightboxEl.hidden = true;
  // Drop the src so a huge data: URI isn't kept resident while the lightbox
  // is closed. Next open() sets it again before unhiding.
  lightboxEl.querySelector(".lightbox-img").removeAttribute("src");
}

function buildLightbox() {
  lightboxEl = document.createElement("div");
  lightboxEl.className = "lightbox-backdrop";
  lightboxEl.hidden = true;
  lightboxEl.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close" title="Close (Esc)">&times;</button>
    <img class="lightbox-img" alt="" />
  `;
  // Click on the backdrop or close button dismisses; clicks on the image
  // itself shouldn't close (so users can drag/right-click/save).
  lightboxEl.addEventListener("click", (e) => {
    if (e.target === lightboxEl || e.target.classList.contains("lightbox-close")) {
      closeImageLightbox();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightboxEl && !lightboxEl.hidden) {
      closeImageLightbox();
    }
  });
  document.body.appendChild(lightboxEl);
}
