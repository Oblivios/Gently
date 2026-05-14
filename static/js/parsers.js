// Per-provider entry-to-bubble parsers. Each `render*Entry` takes a raw entry
// from the session JSONL and returns a structured `{ role, parts, time, sig }`
// the message renderer can consume, or `null` to skip the entry.

import { md, coerceTsSeconds } from "./util.js";

// ---- CLAUDE ---------------------------------------------------------------

export function renderClaudeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const t = entry.type;
  if (t === "file-history-snapshot" || t === "queue-operation" ||
      t === "last-prompt" || t === "permission-mode" || t === "attachment") return null;
  const time = coerceTsSeconds(entry.timestamp);

  if (t === "assistant") {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return null;
    const parts = []; let sig = "";
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && b.text) {
        parts.push({ kind: "text", html: md(b.text) });
        sig += "t" + b.text.length;
      } else if (b.type === "tool_use") {
        parts.push({ kind: "tool_call", name: b.name || "tool", input: b.input ?? {}, id: b.id });
        sig += "u" + (b.id || b.name);
      } else if (b.type === "thinking" && b.thinking) {
        parts.push({ kind: "thinking", text: b.thinking });
        sig += "k" + b.thinking.length;
      } else if (b.type === "image") {
        const src = imageSrcFromBlock(b);
        if (src) {
          parts.push({ kind: "image", src, alt: b?.source?.media_type || "image" });
          sig += "i" + src.length;
        }
      }
    }
    return parts.length ? { role: "assistant", parts, time, sig } : null;
  }

  if (t === "user") {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      const tools = content.filter(b => b && b.type === "tool_result");
      if (tools.length) {
        const parts = tools.map(b => ({
          kind: "tool_result",
          content: extractClaudeToolResult(b, entry),
          diff: extractClaudeDiff(entry),
          toolUseId: b.tool_use_id,
        }));
        return { role: "tool", parts, time, sig: tools.map(b => b.tool_use_id).join(",") };
      }
      const parts = []; let sig = "";
      const text = content.filter(b => b && b.type === "text" && b.text).map(b => b.text).join("\n\n").trim();
      if (text) { parts.push({ kind: "text", html: md(text) }); sig += text.slice(0, 80); }
      // Pasted screenshots / drag-drop images ride as image blocks alongside
      // the prompt text in the user-turn content array.
      for (const b of content) {
        if (!b || b.type !== "image") continue;
        const src = imageSrcFromBlock(b);
        if (src) {
          parts.push({ kind: "image", src, alt: b?.source?.media_type || "image" });
          sig += "i" + src.length;
        }
      }
      if (!parts.length) return null;
      return { role: "user", parts, time, sig };
    }
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (!trimmed || trimmed.includes("<local-command-caveat>")) return null;
      const stdout = trimmed.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i);
      if (stdout) {
        return {
          role: "tool",
          parts: [{ kind: "tool_result", content: stdout[1].trim(), label: "local stdout" }],
          time,
          sig: stdout[1].slice(0, 80),
        };
      }
      const name = trimmed.match(/<command-name>([\s\S]*?)<\/command-name>/i);
      if (name) {
        const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/i);
        const cmd = [name[1].trim(), args?.[1]?.trim()].filter(Boolean).join(" ");
        return { role: "user", parts: [{ kind: "text", html: md("`" + cmd + "`") }], time, sig: "cmd:" + cmd };
      }
      return { role: "user", parts: [{ kind: "text", html: md(trimmed) }], time, sig: trimmed.slice(0, 80) };
    }
    return null;
  }

  if (t === "system") {
    const c = entry.content ?? entry.message?.content;
    if (typeof c !== "string" || !c.trim()) return null;
    const stdout = c.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i);
    if (stdout) {
      return {
        role: "tool",
        parts: [{ kind: "tool_result", content: stdout[1].trim(), label: "system stdout" }],
        time,
        sig: stdout[1].slice(0, 80),
      };
    }
    return null;
  }
  return null;
}

// Build a browser-loadable src out of a Claude image content block. Claude
// emits either inline base64 (the common case for screenshot paste / Read on
// an image file) or a URL reference. Both shapes return as `data:…;base64,…`
// or the URL verbatim — anything else (e.g. a `file://` shape we don't know
// how to fetch) returns "" so the parser drops the part cleanly.
function imageSrcFromBlock(b) {
  const s = b?.source;
  if (!s) return "";
  if (s.type === "base64" && s.data && s.media_type) {
    return `data:${s.media_type};base64,${s.data}`;
  }
  if (s.type === "url" && s.url) return s.url;
  return "";
}

function extractClaudeToolResult(b, entry) {
  const content = b?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => typeof c === "string" ? c : (c?.text ?? JSON.stringify(c))).join("\n");
  return entry?.toolUseResult?.stdout || entry?.toolUseResult?.stderr || "";
}

function extractClaudeDiff(entry) {
  const tur = entry?.toolUseResult;
  if (!tur) return null;
  if (Array.isArray(tur.structuredPatch)) {
    const lines = [];
    for (const h of tur.structuredPatch) if (Array.isArray(h?.lines)) lines.push(...h.lines);
    if (lines.length) return lines.join("\n");
  }
  if (tur.filePath && tur.oldString !== undefined && tur.newString !== undefined) {
    const o = String(tur.oldString).split("\n").map(l => `-${l}`);
    const n = String(tur.newString).split("\n").map(l => `+${l}`);
    return [`--- ${tur.filePath}`, `+++ ${tur.filePath}`, ...o, ...n].join("\n");
  }
  return null;
}

// ---- CODEX ----------------------------------------------------------------

const CODEX_HIDDEN_TOOLS = new Set(["write_stdin", "read_terminal", "command_status", "task_boundary", "notify_user"]);

export function renderCodexEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "response_item") return null;
  const time = coerceTsSeconds(entry.timestamp);
  const p = entry.payload || {};
  const pt = p.type;

  if (pt === "message") {
    const role = p.role || "unknown";
    if (role === "developer" || role === "system") return null;
    const content = Array.isArray(p.content) ? p.content : [];
    // Pasted screenshots in Codex come back as `input_image` blocks carrying a
    // ready-to-use `data:image/...;base64,…` URI. Around them, Codex injects
    // synthetic `<image name=[Image #N]>` / `</image>` text tags into the
    // input_text stream — we strip those so the user prompt reads cleanly.
    const textParts = [];
    const imageParts = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "input_image" && typeof c.image_url === "string" && c.image_url) {
        imageParts.push({ kind: "image", src: c.image_url, alt: "image" });
      } else if (typeof c.text === "string") {
        textParts.push(c.text);
      }
    }
    const stripped = textParts.join("\n\n")
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, "")
      .replace(/<image name=\[Image #\d+\]>\s*<\/image>/gi, "")
      .replace(/<image name=\[Image #\d+\]>/gi, "")
      .replace(/<\/image>/gi, "")
      .trim();
    const parts = []; let sig = "";
    if (stripped) { parts.push({ kind: "text", html: md(stripped) }); sig += stripped.slice(0, 80); }
    for (const img of imageParts) { parts.push(img); sig += "i" + img.src.length; }
    if (!parts.length) return null;
    return { role, parts, time, sig };
  }

  if (pt === "function_call" || pt === "custom_tool_call") {
    const name = p.name || "tool";
    if (CODEX_HIDDEN_TOOLS.has(name)) return null;
    let input = p.arguments ?? p.input ?? "";
    if (typeof input === "string") {
      try { input = JSON.stringify(JSON.parse(input), null, 2); } catch { /* keep raw */ }
    }
    return { role: "assistant", parts: [{ kind: "tool_call", name, input }], time, sig: "tc:" + (p.call_id || p.id || name) };
  }

  if (pt === "function_call_output" || pt === "custom_tool_call_output") {
    let out = "";
    const output = p.output;
    if (typeof output === "string") out = output;
    else if (output && typeof output === "object") {
      out = output.output ?? output.stdout ?? output.error ?? JSON.stringify(output);
    }
    // Strip Codex's "Chunk ID: … / Output:" wrapper when present.
    if (out && /Chunk ID:\s*/.test(out) && /Original token count:/.test(out)) {
      const parts = out.split(/Output:\s*\n/);
      if (parts.length > 1) out = parts.slice(1).join("Output:\n").trim();
    }
    if (!out) return null;
    return { role: "tool", parts: [{ kind: "tool_result", content: out }], time, sig: "to:" + (p.call_id || p.id || "") };
  }

  if (pt === "reasoning") {
    const summary = Array.isArray(p.summary) ? p.summary.map(s => s?.text || "").join("\n\n").trim() : "";
    const contentText = Array.isArray(p.content) ? p.content.map(c => c?.text || "").join("\n\n").trim() : "";
    const text = summary || contentText;
    if (!text) return null;
    return { role: "assistant", parts: [{ kind: "thinking", text, label: "Reasoning" }], time, sig: "r" + text.length };
  }
  return null;
}

// ---- GEMINI ---------------------------------------------------------------

const GEMINI_HIDDEN_TOOLS = new Set(["write_stdin", "read_terminal", "command_status", "task_boundary", "notify_user"]);

export function renderGeminiEntry(msg) {
  if (!msg || typeof msg !== "object") return null;
  const role = msg.type || "unknown";
  const time = coerceTsSeconds(msg.timestamp);
  if (role === "developer" || role === "system") return null;

  let text = "";
  if (Array.isArray(msg.content)) {
    text = msg.content.map(c => (c && typeof c === "object") ? (c.text ?? "") : String(c)).filter(Boolean).join("\n\n");
  } else if (typeof msg.content === "string") {
    text = msg.content;
  }

  const thoughtBits = Array.isArray(msg.thoughts)
    ? msg.thoughts.map(th => (th?.subject ? `**${th.subject}**\n\n` : "") + (th?.description || "")).filter(Boolean).join("\n\n---\n\n")
    : "";

  const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls.filter(c => !GEMINI_HIDDEN_TOOLS.has(c?.name)) : [];

  // Gemini logs a synthetic user-turn "Tool Calls\n\n[…]" summary; if present,
  // render it as a tool bubble rather than as a fake user prompt.
  let synthetic = null;
  if (role === "user" && typeof text === "string" && text.includes("Tool Calls\n\n[")) {
    try { synthetic = JSON.parse(text.split("Tool Calls\n\n")[1]); } catch { /* ignore */ }
  }

  const parts = []; let sig = "";
  if (synthetic && Array.isArray(synthetic)) {
    for (const t of synthetic) {
      if (!t || GEMINI_HIDDEN_TOOLS.has(t.name)) continue;
      parts.push({ kind: "tool_call", name: t.name || "tool", input: t.args ?? {} });
      const r = t.result?.[0]?.functionResponse?.response;
      const out = r?.output ?? r?.error;
      if (typeof out === "string" && out.trim()) parts.push({ kind: "tool_result", content: out });
      sig += "t" + (t.name || "");
    }
    if (parts.length === 0) return null;
    return { role: "tool", parts, time, sig };
  }

  if (text && text.trim()) { parts.push({ kind: "text", html: md(text) }); sig += "x" + text.length; }
  if (thoughtBits) { parts.push({ kind: "thinking", text: thoughtBits }); sig += "k" + thoughtBits.length; }
  for (const t of toolCalls) {
    parts.push({ kind: "tool_call", name: t.name || "tool", input: t.args ?? {} });
    let out = "";
    if (t.resultDisplay) {
      if (typeof t.resultDisplay === "string") out = t.resultDisplay;
      else if (t.resultDisplay.fileDiff) out = t.resultDisplay.fileDiff;
      else out = JSON.stringify(t.resultDisplay, null, 2);
    } else {
      const r = t.result?.[0]?.functionResponse?.response;
      out = r?.output ?? r?.error ?? "";
    }
    if (typeof out === "string" && out.trim()) parts.push({ kind: "tool_result", content: out });
    sig += "tc" + (t.name || "");
  }

  if (parts.length === 0) return null;
  const renderRole = role === "gemini" ? "assistant" : role;
  return { role: renderRole, parts, time, sig };
}

// ---- OPENCODE -------------------------------------------------------------

/** OpenCode entries arrive from the backend as one item per `message` row,
 *  with all of its `part` rows inlined under `entry.parts`. We split that
 *  into one "main" bubble (text + reasoning + tool_call) on the message's
 *  own role, plus one extra "tool" bubble per completed tool with output —
 *  mirroring how Claude/Codex tool results show up in the UI. */
export function renderOpenCodeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "opencode_message") return null;
  const time = coerceTsSeconds(entry.time);
  const role = entry.role === "assistant" ? "assistant"
             : entry.role === "user"      ? "user"
             : entry.role;

  const mainParts = [];
  const toolBubbles = [];
  let mainSig = "";

  for (const p of (entry.parts || [])) {
    if (!p || typeof p !== "object") continue;
    const t = p.type;
    if (t === "step-start" || t === "step-finish") continue;

    if (t === "text" && typeof p.text === "string" && p.text.trim()) {
      mainParts.push({ kind: "text", html: md(p.text) });
      mainSig += "t" + p.text.length;
      continue;
    }
    if (t === "reasoning" && typeof p.text === "string" && p.text.trim()) {
      mainParts.push({ kind: "thinking", text: p.text, label: "Reasoning" });
      mainSig += "k" + p.text.length;
      continue;
    }
    if (t === "tool") {
      const name = p.tool || "tool";
      const state = p.state || {};
      let input = state.input;
      try { if (typeof input !== "string") input = JSON.stringify(input ?? {}, null, 2); } catch { input = String(input); }
      mainParts.push({ kind: "tool_call", name, input, id: p.callID });
      mainSig += "u" + (p.callID || name);

      if (state.status === "completed") {
        let out = state.output;
        if (out && typeof out !== "string") {
          try { out = JSON.stringify(out, null, 2); } catch { out = String(out); }
        }
        if (typeof out === "string" && out.trim()) {
          toolBubbles.push({
            role: "tool",
            parts: [{ kind: "tool_result", content: out, label: name }],
            time: coerceTsSeconds(p._time) || time,
            sig: "to:" + (p.callID || p._id || ""),
          });
        }
      }
      continue;
    }
  }

  const out = [];
  if (mainParts.length) {
    out.push({ role, parts: mainParts, time, sig: mainSig || entry.id });
  }
  out.push(...toolBubbles);
  return out.length ? out : null;
}

// ---- dispatch -------------------------------------------------------------

export function parserFor(provider) {
  if (provider === "codex") return renderCodexEntry;
  if (provider === "gemini") return renderGeminiEntry;
  if (provider === "opencode") return renderOpenCodeEntry;
  return renderClaudeEntry;
}
