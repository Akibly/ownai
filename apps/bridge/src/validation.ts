import { BridgeError, type AdapterCapabilities, type ChatCompletionRequest, type ChatMessage, type ToolCall } from "@ownai/contracts";
import type { NormalizedMessage } from "@ownai/adapters";

/**
 * TRUTH-3: anything the resolved adapter cannot genuinely do is rejected, never
 * simulated. A caller who asks for tools on a chat-website route gets a clear
 * unsupported_feature, not a silently degraded answer that pretends otherwise.
 * A route that declares tools passes them through; whether the provider receives them
 * as a real tool interface ("native") or as a text protocol the bridge parses back
 * ("emulated") is the adapter's business, and it reports which one it is.
 */

export function assertRequestCapabilities(caps: AdapterCapabilities, request: ChatCompletionRequest): void {
  if ((request.tools?.length || request.tool_choice !== undefined) && caps.tools === "none") {
    reject("tools", "This connection cannot call tools.");
  }
  if (request.response_format !== undefined && !caps.json_mode) {
    reject("json_mode", "This connection cannot enforce a response format.");
  }
  if (request.n !== undefined && request.n !== 1) {
    reject("n", "This connection serves one completion per request.");
  }
  if (request.stream && caps.streaming === "none") {
    reject("streaming", "This connection cannot stream a reply.");
  }
  // A stop sequence is a sampling parameter: extractSamplingParams forwards it when the
  // adapter declares it and refuses it, as an unsupported parameter, when it does not.
}

/**
 * Returns the parameters that are not structural and not ignored, i.e. the ones that
 * must appear in the adapter's sampling_params or be refused.
 */
export function extractSamplingParams(request: Record<string, unknown>, caps: AdapterCapabilities): Record<string, unknown> {
  const allowed = new Set<string>(["max_tokens", "max_completion_tokens", ...caps.sampling_params]);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined) continue;
    if (STRUCTURAL.has(key) || IGNORED.has(key)) continue;
    if (!allowed.has(key)) {
      throw new BridgeError("unsupported_parameter", `This connection does not support "${key}".`, {
        param: key,
        capability: key,
      });
    }
    params[key] = value;
  }
  return params;
}

// These fields have already been checked by assertRequestCapabilities. Accepted
// values such as n: 1 and tools: [] are not provider sampling parameters.
const STRUCTURAL = new Set(["model", "messages", "stream", "n", "tools", "tool_choice", "response_format"]);
const IGNORED = new Set(["user", "metadata", "stream_options", "store"]);

/** Flattens OpenAI-shaped messages into what an adapter can actually use. */
export function normalizeMessages(messages: ChatMessage[], caps: AdapterCapabilities): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    const content = flattenContent(message.content);
    const calls = usableToolCalls("tool_calls" in message ? message.tool_calls : undefined);
    if ((message.role === "tool" || calls) && caps.tools === "none") {
      reject("tools", `Message role "${message.role}" requires tool support this connection does not have.`);
    }
    // "developer" is the newer spelling of the instructions role.
    const role = message.role === "developer" ? "system" : message.role;
    if (role === "tool") {
      const toolCallId = readToolCallId(message);
      out.push({ role: "tool", content, ...(toolCallId ? { tool_call_id: toolCallId } : {}) });
      continue;
    }
    out.push({ role, content, ...(calls ? { tool_calls: calls } : {}) });
  }
  // A tool result can legitimately be the newest turn in the conversation: the client
  // is answering a call the model already made, and the user turn is further up.
  if (!out.some((m) => m.role === "user" || m.role === "tool")) {
    throw new BridgeError("invalid_request", "The request contains no user message.");
  }
  return out;
}

function readToolCallId(message: ChatMessage): string | undefined {
  const value = "tool_call_id" in message ? message.tool_call_id : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Only keeps calls a provider could actually execute: an id, a name, and an argument
 * string. Anything else is dropped rather than forwarded as a half-formed request.
 */
function usableToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<ToolCall>;
    if (typeof candidate.id !== "string" || typeof candidate.function?.name !== "string") continue;
    calls.push({
      id: candidate.id,
      type: "function",
      function: {
        name: candidate.function.name,
        arguments: typeof candidate.function.arguments === "string" ? candidate.function.arguments : "{}",
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function flattenContent(content: ChatMessage["content"]): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content.length > 0 ? content : null;
  let text = "";
  for (const part of content) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    reject("vision", `Content part "${part.type}" requires capabilities this connection does not have.`);
  }
  return text.length > 0 ? text : null;
}

function reject(capability: string, message: string): never {
  throw new BridgeError("unsupported_feature", message, { capability });
}
