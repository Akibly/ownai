import { randomBytes } from "node:crypto";
import { BridgeError, type ToolCall } from "@ownai/contracts";

/**
 * The text protocol a browser route uses in place of a real tool interface: the
 * definitions are described in the prompt, and a reply carrying a call is parsed back
 * into the shape the client sent. It is genuinely a different mechanism from native
 * tool calling, so it is reported as "emulated" and the owner opts into it.
 */

/** A composer is a text box: an unbounded schema would be typed in full or lost. */
export const MAX_TOOLS = 32;
export const MAX_TOOL_BLOCK_CHARS = 8_000;

const FENCE = "```";
const MARKER = "ownai_tool";

interface FunctionSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Reads OpenAI-shaped definitions. Anything without a usable name cannot be offered to the model. */
function specs(tools: unknown[]): FunctionSpec[] {
  const out: FunctionSpec[] = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const fn = (entry as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) continue;
    const { name, description, parameters } = fn as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({
      name,
      ...(typeof description === "string" && description.length > 0 ? { description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    });
  }
  return out;
}

/** The instruction block prepended to a prompt when the client offered functions. */
export function buildToolBlock(tools: unknown[]): string {
  const declared = specs(tools);
  if (declared.length === 0) return "";
  if (declared.length > MAX_TOOLS) {
    throw new BridgeError("invalid_request", `This connection offers the model at most ${MAX_TOOLS} functions.`, {
      param: "tools",
    });
  }
  const block = [
    "The user's environment can run functions for you. Available functions:",
    JSON.stringify(declared.map((s) => ({ name: s.name, ...("description" in s ? { description: s.description } : {}), ...("parameters" in s ? { parameters: s.parameters } : {}) }))),
    "",
    "To have one run, reply with only this block:",
    `${FENCE}${MARKER}`,
    '{"name":"<function name>","arguments":{<JSON arguments>}}',
    FENCE,
    "Use one block per function. If no function is needed, answer normally and write no block.",
  ].join("\n");
  if (block.length > MAX_TOOL_BLOCK_CHARS) {
    throw new BridgeError(
      "invalid_request",
      `These function definitions are ${block.length} characters, past the ${MAX_TOOL_BLOCK_CHARS} this connection can put in a message box.`,
      { param: "tools" },
    );
  }
  return block;
}

export interface ParsedReply {
  /** The reply with any protocol blocks removed, so a client never displays raw JSON as prose. */
  prose: string;
  calls: ToolCall[];
}

/**
 * Finds this protocol's blocks and nothing else. A block whose name was not offered,
 * or whose arguments will not parse, is left in the prose as an unexecuted call: an
 * invented name or half-read argument list would be worse than no call at all.
 */
export function parseToolReply(text: string, tools: unknown[]): ParsedReply {
  const names = new Set(specs(tools).map((spec) => spec.name));
  if (names.size === 0) return { prose: text, calls: [] };
  const fenced = readFenced(text, names);
  const rendered = readRendered(fenced.prose, names);
  return { prose: rendered.prose, calls: [...fenced.calls, ...rendered.calls] };
}

/** Finds this protocol's blocks and nothing else. A block whose name was not offered,
 * or whose arguments will not parse, is left in the prose as an unexecuted call: an
 * invented name or half-read argument list would be worse than no call at all.
 */
function readFenced(text: string, names: Set<string>): ParsedReply {
  const calls: ToolCall[] = [];
  let prose = "";
  let cursor = 0;

  // Scanned in pairs rather than one greedy pattern, because a reply may mix prose and blocks.
  for (;;) {
    const open = text.indexOf(FENCE, cursor);
    if (open === -1) {
      prose += text.slice(cursor);
      break;
    }
    // Whatever came before this fence is the model's own answer, so it stays.
    prose += text.slice(cursor, open);
    const bodyStart = open + FENCE.length;
    const close = text.indexOf(FENCE, bodyStart);
    if (close === -1) {
      prose += text.slice(open);
      break;
    }
    const lineEnd = text.indexOf("\n", bodyStart);
    const end = close + FENCE.length;
    cursor = end;
    if (lineEnd === -1 || lineEnd > close) {
      prose += text.slice(open, end);
      continue;
    }
    const info = text.slice(bodyStart, lineEnd).trim().toLowerCase();
    const call = info === "" || info === "json" || info === MARKER ? readCall(text.slice(lineEnd + 1, close), names) : undefined;
    if (call) calls.push(call);
    else prose += text.slice(open, end);
  }

  return { prose: prose.trim(), calls };
}

/**
 * A chat page renders the reply as markdown, so a fenced block reaches us with the
 * backticks gone: only the marker line and the JSON survive as text. This reads that
 * form, and keeps every rule the fenced form follows.
 */
const MARKER_LINE = /^[ \t]*ownai_tool[ \t]*$/gm;

function readRendered(text: string, names: Set<string>): ParsedReply {
  const calls: ToolCall[] = [];
  let prose = "";
  let cursor = 0;
  MARKER_LINE.lastIndex = 0;
  for (let match = MARKER_LINE.exec(text); match !== null; match = MARKER_LINE.exec(text)) {
    const start = match.index;
    let at = start + match[0].length;
    while (at < text.length && /\s/.test(text[at]!)) at++;
    const object = jsonObjectAt(text, at);
    if (!object) continue;
    const call = readCall(object.body, names);
    if (!call) continue;
    let end = object.end;
    // A closing fence that survived the renderer belongs to this block, not the prose.
    while (end < text.length && /\s/.test(text[end]!)) end++;
    if (text.startsWith(FENCE, end)) end += FENCE.length;
    prose += text.slice(cursor, start);
    cursor = end;
    calls.push(call);
  }
  prose += text.slice(cursor);
  return { prose: prose.trim(), calls };
}

/** The end of a complete JSON object, so prose after the block is not swallowed. */
function jsonObjectAt(text: string, start: number): { body: string; end: number } | undefined {
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return undefined;
}

function readCall(body: string, names: Set<string>): ToolCall | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { name, arguments: args } = value as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string" || !names.has(name)) return undefined;
  const parsed = argumentString(args);
  if (parsed === undefined) return undefined;
  return {
    id: `call_${randomBytes(6).toString("base64url")}`,
    type: "function",
    function: { name, arguments: parsed },
  };
}

/** Arguments travel as a JSON string, so anything that will not become one is not a call. */
function argumentString(args: unknown): string | undefined {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") {
    try {
      return JSON.stringify(JSON.parse(args) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof args !== "object") return undefined;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}
