// Build a Markdown export of a tab's current items. Used by the copy-md
// button on pane controls.

import { fenced, looksJson } from "./util.js";
import { PROVIDER_LABEL } from "./state.js";
import { parserFor } from "./parsers.js";

export function buildMarkdownExport(tab) {
  if (!tab) return "";
  const lines = [];
  lines.push(`# ${tab.label || tab.sessionId}`);
  if (tab.project) lines.push(`\n_Project:_ \`${tab.project}\``);
  lines.push(`_Provider:_ **${PROVIDER_LABEL[tab.provider]}**`);
  lines.push(`_Session:_ \`${tab.sessionId}\`\n\n---\n`);
  const renderEntry = parserFor(tab.provider);
  for (const entry of tab.items) {
    const out = renderEntry(entry);
    if (!out) continue;
    const list = Array.isArray(out) ? out : [out];
    for (const r of list) {
    if (!r) continue;
    lines.push(`**${r.role}**`);
    for (const p of r.parts) {
      if (p.kind === "text") {
        const div = document.createElement("div"); div.innerHTML = p.html;
        lines.push(div.textContent.trim());
      } else if (p.kind === "tool_call") {
        const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}, null, 2);
        lines.push(`> tool call · **${p.name}**`);
        lines.push(fenced(input, looksJson(input) ? "json" : "text"));
      } else if (p.kind === "tool_result") {
        lines.push(`> tool result`);
        lines.push(fenced(p.diff || p.content || "<no output>", p.diff ? "diff" : "text"));
      } else if (p.kind === "thinking") {
        lines.push(`<details><summary>thinking</summary>\n\n${p.text}\n\n</details>`);
      } else if (p.kind === "image") {
        // Bare data: URIs balloon the export to multiple MB per image and
        // don't paste usefully into chat / docs. Substitute a marker instead.
        lines.push(p.src?.startsWith("data:") ? "![image](inline)" : `![image](${p.src})`);
      }
      lines.push("");
    }
    }
  }
  return lines.join("\n");
}
