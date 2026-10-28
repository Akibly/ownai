import { describe, expect, it } from "vitest";
import { BridgeError } from "@ownai/contracts";
import { MAX_TOOL_BLOCK_CHARS, MAX_TOOLS, buildToolBlock, parseToolReply } from "../src/browser/tool-protocol.ts";

/** Pure text in, text out: no page, no provider, no turn spent. */
const weather = { type: "function", function: { name: "get_weather", description: "Current conditions", parameters: { type: "object" } } };

const block = (payload: string) => `\`\`\`ownai_tool\n${payload}\n\`\`\``;

describe("buildToolBlock", () => {
  it("describes the functions the client actually named", () => {
    const built = buildToolBlock([weather]);
    expect(built).toContain('"name":"get_weather"');
    expect(built).toContain("Current conditions");
    expect(built).toContain('"type":"object"');
    expect(built).toContain("ownai_tool");
  });

  it("sends no block for definitions the bridge cannot name", () => {
    expect(buildToolBlock([])).toBe("");
    expect(buildToolBlock([{ type: "function" }, { function: { name: "" } }, null, "x"])).toBe("");
  });

  it("refuses more functions than a message box can carry", () => {
    const many = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({ type: "function", function: { name: `t${i}` } }));
    expect(() => buildToolBlock(many)).toThrowError(BridgeError);
  });

  it("refuses definitions too large to type, rather than sending a truncated contract", () => {
    const huge = [{ type: "function", function: { name: "big", description: "d".repeat(MAX_TOOL_BLOCK_CHARS) } }];
    const thrown = (() => {
      try {
        buildToolBlock(huge);
        return undefined;
      } catch (err) {
        return err as BridgeError;
      }
    })();
    expect(thrown?.code).toBe("invalid_request");
    expect(thrown?.details.param).toBe("tools");
  });
});

describe("parseToolReply", () => {
  it("returns a call the client can execute, with the block out of the prose", () => {
    const parsed = parseToolReply(`Let me check.${block('{"name":"get_weather","arguments":{"city":"Ankara"}}')}done`, [weather]);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]).toMatchObject({ type: "function", function: { name: "get_weather", arguments: '{"city":"Ankara"}' } });
    expect(parsed.prose).toBe("Let me check.done");
  });

  it("accepts the shapes a model really produces for the same call", () => {
    const variants = [
      block('{"name":"get_weather","arguments":"{\\"city\\":\\"Ankara\\"}"}'),
      `\`\`\`json\n{"name":"get_weather","arguments":{"city":"Ankara"}}\n\`\`\``,
      `\`\`\`\n{"name":"get_weather","arguments":{"city":"Ankara"}}\n\`\`\``,
    ];
    for (const text of variants) {
      const parsed = parseToolReply(text, [weather]);
      expect(parsed.calls[0]?.function.arguments).toBe('{"city":"Ankara"}');
    }
  });

  it("keeps a call with no arguments, because the function may take none", () => {
    expect(parseToolReply(block('{"name":"get_weather"}'), [weather]).calls[0]?.function.arguments).toBe("{}");
  });

  it.each([
    ["an unknown function", block('{"name":"delete_everything","arguments":{}}')],
    ["arguments that will not parse", block('{"name":"get_weather","arguments":"not json"}')],
    ["arguments of the wrong type", block('{"name":"get_weather","arguments":7}')],
    ["a body that is not an object", block('"get_weather"')],
    ["a malformed block", block('{"name":"get_weather"')],
  ])("claims nothing from %s", (_name, text) => {
    const parsed = parseToolReply(text, [weather]);
    expect(parsed.calls).toEqual([]);
    expect(parsed.prose).toContain(text);
  });

  it("collects several calls from one reply", () => {
    const parsed = parseToolReply(`${block('{"name":"get_weather","arguments":{}}')}\n${block('{"name":"get_weather","arguments":{}}')}`, [weather]);
    expect(parsed.calls).toHaveLength(2);
    expect(parsed.prose).toBe("");
  });

  it("leaves code the model wrote for other reasons in the prose", () => {
    const text = "```python\nprint('hi')\n```";
    const parsed = parseToolReply(text, [weather]);
    expect(parsed.calls).toEqual([]);
    expect(parsed.prose).toBe(text);
  });

  it("treats an unterminated fence as prose", () => {
    const parsed = parseToolReply(`${block('{"name":"get_weather","arguments":{}}')}\n\`\`\`ownai_tool`, [weather]);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.prose).toContain("ownai_tool");
  });

  it("reads the rendered form a markdown chat page actually shows", () => {
    // A page renders ```ownai_tool as a code block, so innerText keeps the marker line
    // and the JSON but drops the backticks.
    const text = 'Checking now.\nownai_tool\n{"name":"get_weather","arguments":{"city":"Ankara"}}';
    const parsed = parseToolReply(text, [weather]);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.function).toEqual({ name: "get_weather", arguments: '{"city":"Ankara"}' });
    expect(parsed.prose).toBe("Checking now.");
  });

  it("reads the rendered form even when the closing fence survives", () => {
    const text = 'ownai_tool\n{"name":"get_weather","arguments":{"note":"a } inside"}}\n```';
    const parsed = parseToolReply(text, [weather]);
    expect(parsed.calls[0]?.function.arguments).toBe('{"note":"a } inside"}');
    expect(parsed.prose).toBe("");
  });

  it("claims nothing from a rendered marker naming a function it was not offered", () => {
    const text = 'ownai_tool\n{"name":"delete_everything","arguments":{}}';
    const parsed = parseToolReply(text, [weather]);
    expect(parsed.calls).toEqual([]);
    expect(parsed.prose).toContain("delete_everything");
  });

  it("passes the reply through untouched when the client offered no functions", () => {
    expect(parseToolReply("plain answer", []).prose).toBe("plain answer");
  });
});
