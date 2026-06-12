// Agent-chat feed formatting: turn the raw transcript lines the Hyades world-agent returns into a
// clean feed. Two ugly realities this module absorbs (shapes observed on the live backend):
//
//  1. Model-format artifacts leak into ASSISTANT text — `<tool_call_box>{"name":"Observe",…}</tool_call_box>`
//     blocks (sometimes with malformed inner JSON), bare `<tool_call>` tags, and bare JSON tool-call
//     objects in THREE key vocabularies: `{"action":"MoveSelf","direction":"forward","distance":10}`,
//     `{"name":"Observe","arguments":{}}`, and holo3.1's `{"tool":"MoveSelf","parameters":{"north":3}}`.
//     splitAssistantMessage() separates the surrounding prose from those calls so the prose renders
//     normally and each call becomes a compact chip.
//
//  2. TOOL-role lines carry the raw tool RESULT text — usually a JSON blob (the Observe view, a
//     TellusPatch like `{"type":"asset.generate.queued",…}`) or a short server sentence
//     ("remembered. …", "rejected: …", "look: …"). describeToolResult() derives a humanized
//     name + brief summary heuristically.

export interface AgentToolChip {
  /** Humanized tool/action name, e.g. "Observe", "MoveSelf", "Generate". */
  name: string;
  /** Optional one-line detail, already clipped, e.g. `dx 2, dz −1` or `"a small fox"`. */
  summary?: string;
}

export type AgentFeedSegment =
  | { kind: "prose"; text: string }
  | { kind: "chip"; chip: AgentToolChip };

// One line in the "Your Agent" chat thread: either something you typed ("you"), one of the agent's
// dialog/tool turns merged in from its transcript, or a local system note ("— thread reset —").
export interface AgentChatLine {
  id: number;
  who: "you" | "agent" | "tool" | "system";
  text: string;
}

// Render-time projection of the chat thread: prose lines + compact tool chips, with runs of
// ≥CHIP_GROUP_MIN consecutive chips collapsed into one expandable group.
export type AgentFeedItem =
  | { kind: "prose"; key: string; who: "you" | "agent" | "system"; text: string }
  | { kind: "chip"; key: string; chip: AgentToolChip }
  | { kind: "chipGroup"; key: string; chips: { key: string; chip: AgentToolChip }[] };

export const CHIP_GROUP_MIN = 3;

export function buildAgentFeed(lines: AgentChatLine[]): AgentFeedItem[] {
  // 1. Flatten lines into prose/chip items: tool lines become one chip; assistant lines are split so
  //    leaked model-format tool calls (<tool_call_box>, bare {"action":…} JSON) render as chips too.
  const flat: (AgentFeedItem & { kind: "prose" | "chip" })[] = [];
  for (const line of lines) {
    if (line.who === "tool") {
      flat.push({ kind: "chip", key: `${line.id}`, chip: describeToolResult(line.text) });
    } else if (line.who === "agent") {
      splitAssistantMessage(line.text).forEach((seg, i) => {
        if (seg.kind === "chip") flat.push({ kind: "chip", key: `${line.id}:${i}`, chip: seg.chip });
        else flat.push({ kind: "prose", key: `${line.id}:${i}`, who: "agent", text: seg.text });
      });
    } else {
      flat.push({ kind: "prose", key: `${line.id}`, who: line.who, text: line.text });
    }
  }
  // 2. Collapse runs of ≥CHIP_GROUP_MIN consecutive chips into one group (keyed by the first chip).
  const items: AgentFeedItem[] = [];
  let run: (AgentFeedItem & { kind: "chip" })[] = [];
  const flush = () => {
    if (run.length >= CHIP_GROUP_MIN) {
      items.push({ kind: "chipGroup", key: `g:${run[0].key}`, chips: run.map((c) => ({ key: c.key, chip: c.chip })) });
    } else {
      items.push(...run);
    }
    run = [];
  };
  for (const item of flat) {
    if (item.kind === "chip") run.push(item);
    else {
      flush();
      items.push(item);
    }
  }
  flush();
  return items;
}

const SUMMARY_MAX = 60;

/** Clip to n chars on a soft boundary, appending an ellipsis when truncated. */
function clip(text: string, n: number = SUMMARY_MAX): string {
  const t = text.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).trimEnd()}…`;
}

/** Strip XML-ish tags + JSON punctuation noise and collapse whitespace — for free-text summaries. */
function stripNoise(text: string): string {
  return text
    .replace(/<[^>\n]{0,80}>/g, " ") // tags (incl. stray <tool_call_box>)
    .replace(/[{}[\]"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "asset.generate.queued" → "Generate queued"; "moveSelf"/"move_self" → "MoveSelf"-ish; cap first letter. */
function humanizeToolName(raw: string): string {
  const t = raw.trim();
  if (!t) return "Tool";
  if (t.includes(".")) {
    // Patch/event types like "asset.generate.queued" / "action.rejected": drop the leading namespace,
    // capitalize the verb, keep the qualifier(s) lowercase: "Generate queued", "Rejected".
    const parts = t.split(".").filter(Boolean);
    const rest = parts.length > 1 ? parts.slice(1) : parts;
    const [head, ...tail] = rest;
    const cap = head.charAt(0).toUpperCase() + head.slice(1);
    return [cap, ...tail].join(" ");
  }
  const cleaned = t.replace(/[_-]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Keys whose string value reads better bare ("a small fox") than as `key "a small fox"`. */
const BARE_VALUE_KEYS = new Set(["prompt", "text", "message", "query", "question", "note", "reason"]);

/** Format a negative number with a true minus sign so chips read `dz −1`, not `dz -1`. */
function formatNumber(value: number): string {
  const s = String(Math.round(value * 100) / 100);
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
}

/** Compact one-line `key value, key value` summary of a tool-call's arguments. */
export function summarizeToolArgs(args: unknown): string | undefined {
  if (args === null || args === undefined) return undefined;
  if (typeof args === "string") {
    const t = args.trim();
    if (!t || t === "{}" || t === "{}}" || t === '"{}"') return undefined;
    // Arguments sometimes arrive as a JSON-encoded STRING — unwrap once if it parses.
    try {
      return summarizeToolArgs(JSON.parse(t));
    } catch {
      return clip(`"${stripNoise(t)}"`);
    }
  }
  if (typeof args !== "object") return clip(String(args));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const v = value.trim();
      if (!v) continue;
      parts.push(BARE_VALUE_KEYS.has(key) ? `"${clip(v, 32)}"` : `${key} ${clip(v, 20)}`);
    } else if (typeof value === "number") {
      parts.push(`${key} ${formatNumber(value)}`);
    } else if (typeof value === "boolean") {
      parts.push(`${key} ${value}`);
    } else {
      // nested object/array — name it, don't dump it
      parts.push(`${key} …`);
    }
    if (parts.length >= 3) break;
  }
  if (parts.length === 0) return undefined;
  return clip(parts.join(", "));
}

/** Extract one balanced `{…}` JSON object starting at `start` (string-aware). Null if unbalanced. */
function extractBalancedJson(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse one tool-call object out of jsonish text. Accepts all three observed wire shapes:
 *   {"name": "Observe", "arguments": {...|"{...}"}}    (OpenAI-style; arguments may be malformed)
 *   {"tool": "MoveSelf", "parameters": {"north": 3}}   (holo3.1-style — live world-"main" shape)
 *   {"action": "MoveSelf", ...inline args...}          (Tellus action-style)
 * Falls back to a regex name grab when the JSON itself is broken (a real, observed case).
 */
export function parseToolCallObject(jsonish: string): AgentToolChip | null {
  const t = jsonish.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (obj && typeof obj === "object") {
      const callName =
        typeof obj.name === "string" && obj.name.trim()
          ? obj.name
          : typeof obj.tool === "string" && obj.tool.trim()
            ? obj.tool
            : null;
      if (callName) {
        return {
          name: humanizeToolName(callName),
          summary: summarizeToolArgs(obj.arguments ?? obj.parameters ?? obj.args),
        };
      }
      if (typeof obj.action === "string" && obj.action.trim()) {
        const { action: _action, ...rest } = obj;
        return { name: humanizeToolName(obj.action), summary: summarizeToolArgs(rest) };
      }
    }
  } catch {
    /* malformed JSON (e.g. `{"name": "Observe", "arguments": "{}}`) — regex fallback below */
  }
  const m = /"(?:name|tool|action)"\s*:\s*"([^"]+)"/.exec(t);
  if (m) return { name: humanizeToolName(m[1]) };
  return null;
}

/** True when the parsed-or-raw text looks like a tool-call object (so bare JSON in prose is a call). */
function looksLikeToolCallJson(jsonish: string): boolean {
  return /"(?:action|name|tool)"\s*:\s*"/.test(jsonish);
}

/**
 * Parse a tool-name line's inline remainder as whitespace-separated `key:value` tokens
 * (`direction:north distance:5`; a multi-word value runs until the next `key:` token). Returns {}
 * for an empty remainder (bare tool-name line) and null when the remainder is ordinary prose.
 */
function parseInlineArgs(rest: string): Record<string, string> | null {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const args: Record<string, string> = {};
  let key: string | null = null;
  for (const tok of tokens) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(tok);
    if (m) {
      key = m[1];
      args[key] = m[2];
    } else if (key) {
      args[key] = args[key] ? `${args[key]} ${tok}` : tok;
    } else {
      return null; // leading non-key:value token → this line is prose, not a call
    }
  }
  return args;
}

interface CallMarker {
  start: number;
  end: number;
  chip: AgentToolChip | null;
}

const TAGGED_CALL = /<tool_call(?:_box)?>/g;

// The Tellus world-agent tool vocabulary (Hyades TellusWorldPlugin + BrowserWorldPlugin). Some models
// emit an assistant turn whose ENTIRE text is just the bare tool name ("Observe" — observed live on
// world "main"); an exact match against this set is chipped, anything else stays prose.
const KNOWN_TOOL_NAMES = new Set([
  "Observe", "Look", "Remember", "MoveSelf", "SculptTerrain", "Generate", "MoveAsset",
  "ListAvatars", "SetAvatar", "SetAvatarScale", "PlayAnimation", "SetAssetAnimation", "Act",
]);

/**
 * Split an assistant message into prose + tool-call chips. Handles `<tool_call_box>…</tool_call_box>`,
 * bare `<tool_call>…</tool_call>` (closed or runaway-to-end), and bare JSON tool-call objects. A block
 * whose call can't be identified at all is dropped as noise rather than rendered raw.
 */
export function splitAssistantMessage(text: string): AgentFeedSegment[] {
  // A message that IS a bare known tool name (live holo3.1 shape) chips directly.
  if (KNOWN_TOOL_NAMES.has(text.trim())) return [{ kind: "chip", chip: { name: text.trim() } }];

  const markers: CallMarker[] = [];

  // 1. Tagged blocks.
  TAGGED_CALL.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = TAGGED_CALL.exec(text)) !== null) {
    const openEnd = tag.index + tag[0].length;
    const closeTag = tag[0] === "<tool_call_box>" ? "</tool_call_box>" : "</tool_call>";
    const closeIdx = text.indexOf(closeTag, openEnd);
    const inner = closeIdx >= 0 ? text.slice(openEnd, closeIdx) : text.slice(openEnd);
    const end = closeIdx >= 0 ? closeIdx + closeTag.length : text.length;
    markers.push({ start: tag.index, end, chip: parseToolCallObject(inner) });
    TAGGED_CALL.lastIndex = end;
  }

  // 2. Plain-text call blocks (live holo3.1 shapes): a line that IS a known tool name — bare,
  //    with inline `key:value` tokens, or followed by contiguous `key: value` argument lines:
  //        MoveSelf direction:north distance:5
  //        MoveSelf
  //        destination: North, approximately 3 steps forward
  const lines = text.split("\n");
  let offset = 0;
  for (let li = 0; li < lines.length; li++) {
    const lineStart = offset;
    offset += lines[li].length + 1; // +1 for the split-away "\n"
    const head = /^[ \t]*([A-Z][A-Za-z]*)\b(.*)$/.exec(lines[li]);
    if (!head || !KNOWN_TOOL_NAMES.has(head[1])) continue;
    if (markers.some((m) => lineStart >= m.start && lineStart < m.end)) continue;
    const args = parseInlineArgs(head[2]);
    if (args === null) continue; // "Look at that!" — prose that merely starts with a tool word
    let end = lineStart + lines[li].length;
    while (li + 1 < lines.length) {
      const kv = /^[ \t]*([A-Za-z_][\w-]*)[ \t]*:[ \t]+(.+)$/.exec(lines[li + 1]);
      if (!kv) break;
      li++;
      args[kv[1]] = kv[2].trim();
      end = offset + lines[li].length;
      offset += lines[li].length + 1;
    }
    markers.push({ start: lineStart, end, chip: { name: humanizeToolName(head[1]), summary: summarizeToolArgs(args) } });
  }

  // 3. Bare JSON tool-call objects outside the tagged ranges.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const braceIdx = text.indexOf("{", searchFrom);
    if (braceIdx < 0) break;
    searchFrom = braceIdx + 1;
    if (markers.some((m) => braceIdx >= m.start && braceIdx < m.end)) continue;
    const json = extractBalancedJson(text, braceIdx);
    if (!json || !looksLikeToolCallJson(json)) continue;
    const chip = parseToolCallObject(json);
    if (!chip) continue;
    markers.push({ start: braceIdx, end: braceIdx + json.length, chip });
    searchFrom = braceIdx + json.length;
  }

  if (markers.length === 0) {
    const prose = text.trim();
    return prose ? [{ kind: "prose", text: prose }] : [];
  }

  markers.sort((a, b) => a.start - b.start);
  const segments: AgentFeedSegment[] = [];
  let cursor = 0;
  for (const m of markers) {
    const prose = text.slice(cursor, m.start).trim();
    if (prose) segments.push({ kind: "prose", text: prose });
    if (m.chip) segments.push({ kind: "chip", chip: m.chip });
    cursor = m.end;
  }
  const tail = text.slice(cursor).trim();
  if (tail) segments.push({ kind: "prose", text: tail });
  return segments;
}

/**
 * Humanize a TOOL-role line (the tool's RESULT text) into a chip. Heuristic by design — the first
 * line / JSON shape usually identifies the tool; otherwise show the first ~60 chars, noise-stripped.
 */
export function describeToolResult(text: string): AgentToolChip {
  const t = text.trim();

  // Tagged or bare tool-call echoes sometimes land in the tool slot too — same parse as assistant.
  const tagIdx = t.search(TAGGED_CALL);
  TAGGED_CALL.lastIndex = 0;
  if (tagIdx >= 0 || t.startsWith("{")) {
    const jsonStart = t.indexOf("{");
    const json = jsonStart >= 0 ? extractBalancedJson(t, jsonStart) : null;
    if (json) {
      const asCall = looksLikeToolCallJson(json) ? parseToolCallObject(json) : null;
      if (asCall) return asCall;
      try {
        const obj = JSON.parse(json) as Record<string, unknown>;
        if (obj && typeof obj === "object") {
          if (typeof obj.type === "string" && obj.type.trim()) {
            // TellusPatch result, e.g. {"type":"asset.generate.queued",…} / {"type":"action.rejected","reason":…}
            const reason = typeof obj.reason === "string" ? obj.reason : undefined;
            const prompt = typeof obj.prompt === "string" ? obj.prompt : undefined;
            return {
              name: humanizeToolName(obj.type),
              summary: reason ? clip(reason) : prompt ? clip(`"${prompt}"`) : undefined,
            };
          }
          // The Observe view blob: position/terrain/nearby keys, no type.
          if ("position" in obj || "terrain" in obj || "nearby" in obj || "visitors" in obj) {
            return { name: "Observe" };
          }
        }
      } catch {
        /* fall through to the generic clip */
      }
    }
    const noise = stripNoise(t);
    return noise ? { name: "Tool", summary: clip(noise) } : { name: "Tool" };
  }

  // Short server sentences with a recognizable head.
  const rejected = /^rejected:\s*(.*)$/is.exec(t);
  if (rejected) return { name: "Rejected", summary: clip(stripNoise(rejected[1])) };
  if (/^remembered\b/i.test(t)) return { name: "Remember" };
  const look = /^look:\s*(.*)$/is.exec(t);
  if (look) return { name: "Look", summary: clip(stripNoise(look[1])) };
  if (/^you have already observed/i.test(t)) return { name: "Observe", summary: "already observed this turn" };
  const unavailable = /^(\w+)\s+is unavailable\b/i.exec(t);
  if (unavailable) return { name: humanizeToolName(unavailable[1]), summary: "unavailable" };

  const firstLine = stripNoise(t.split("\n", 1)[0] ?? "");
  return firstLine ? { name: "Tool", summary: clip(firstLine) } : { name: "Tool" };
}
