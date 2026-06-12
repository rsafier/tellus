import { describe, expect, it } from "vitest";
import {
  buildAgentFeed,
  describeToolResult,
  parseToolCallObject,
  splitAssistantMessage,
  summarizeToolArgs,
  type AgentChatLine,
} from "./agent-chat-format";

// Shapes below are verbatim from live world-"main" transcripts (hyades, 2026-06-11).

describe("splitAssistantMessage", () => {
  it("passes plain prose through untouched", () => {
    expect(splitAssistantMessage("let me look around and see what there is")).toEqual([
      { kind: "prose", text: "let me look around and see what there is" },
    ]);
  });

  it("turns a bare action-JSON line into a single chip", () => {
    expect(splitAssistantMessage('{"action":"Observe"}')).toEqual([
      { kind: "chip", chip: { name: "Observe", summary: undefined } },
    ]);
  });

  it("summarizes inline action args", () => {
    const segs = splitAssistantMessage('{"action":"MoveSelf","direction":"forward","distance":10}');
    expect(segs).toEqual([
      { kind: "chip", chip: { name: "MoveSelf", summary: "direction forward, distance 10" } },
    ]);
  });

  it("splits prose followed by a bare action object", () => {
    const segs = splitAssistantMessage(
      "I'd love to come find you! Let me see where you are first.\n\n{\"action\":\"Observe\"}",
    );
    expect(segs).toEqual([
      { kind: "prose", text: "I'd love to come find you! Let me see where you are first." },
      { kind: "chip", chip: { name: "Observe", summary: undefined } },
    ]);
  });

  it("extracts a <tool_call_box> block (well-formed inner JSON)", () => {
    const segs = splitAssistantMessage(
      'Hello there!\n\n<tool_call_box>\n{"name": "Observe", "arguments": {}}\n</tool_call_box>',
    );
    expect(segs).toEqual([
      { kind: "prose", text: "Hello there!" },
      { kind: "chip", chip: { name: "Observe", summary: undefined } },
    ]);
  });

  it("survives the malformed inner JSON seen live", () => {
    // Verbatim live shape: arguments value is the broken string `"{}}`.
    const segs = splitAssistantMessage('<tool_call_box>\n{"name": "Observe", "arguments": "{}}\n</tool_call_box>');
    expect(segs).toEqual([{ kind: "chip", chip: { name: "Observe" } }]);
  });

  it("handles string-encoded arguments", () => {
    const segs = splitAssistantMessage('<tool_call_box>\n{"name": "Observe", "arguments": "{}"}\n</tool_call_box>');
    expect(segs).toEqual([{ kind: "chip", chip: { name: "Observe", summary: undefined } }]);
  });

  it("keeps prose between multiple boxes in one message", () => {
    const segs = splitAssistantMessage(
      '<tool_call_box>\n{"name": "Observe", "arguments": {}}\n</tool_call_box>\n\n' +
        "Let me wander a little and get to know this land better.\n\n" +
        '<tool_call_box>\n{"name": "MoveSelf", "arguments": {"direction": "forward", "distance": 8}}\n</tool_call_box>\n\n' +
        "I'm strolling forward, getting a feel for the terrain beneath my feet.",
    );
    expect(segs).toEqual([
      { kind: "chip", chip: { name: "Observe", summary: undefined } },
      { kind: "prose", text: "Let me wander a little and get to know this land better." },
      { kind: "chip", chip: { name: "MoveSelf", summary: "direction forward, distance 8" } },
      { kind: "prose", text: "I'm strolling forward, getting a feel for the terrain beneath my feet." },
    ]);
  });

  it("shows bare-key string args (prompt/question) as a quoted value", () => {
    const segs = splitAssistantMessage(
      '<tool_call_box>\n{"name": "Look", "arguments": {"question": "Can I see a beach nearby?"}}\n</tool_call_box>',
    );
    expect(segs).toEqual([
      { kind: "chip", chip: { name: "Look", summary: '"Can I see a beach nearby?"' } },
    ]);
  });

  it("handles a runaway (unclosed) tool_call tag", () => {
    const segs = splitAssistantMessage('On my way!\n<tool_call>\n{"name": "MoveSelf", "arguments": {"dx": 2, "dz": -1}}');
    expect(segs).toEqual([
      { kind: "prose", text: "On my way!" },
      { kind: "chip", chip: { name: "MoveSelf", summary: "dx 2, dz −1" } },
    ]);
  });

  it("turns the holo3.1 tool/parameters shape into a chip (verbatim live shape)", () => {
    // Verbatim from a live world-"main" transcript (modelId holo3.1, 2026-06-11): the WHOLE assistant
    // message is one pretty-printed {"tool": …, "parameters": …} object.
    expect(splitAssistantMessage('{\n  "tool": "Observe",\n  "parameters": {}\n}')).toEqual([
      { kind: "chip", chip: { name: "Observe", summary: undefined } },
    ]);
    expect(
      splitAssistantMessage('{\n  "tool": "MoveSelf",\n  "parameters": {\n    "north": 3\n  }\n}'),
    ).toEqual([{ kind: "chip", chip: { name: "MoveSelf", summary: "north 3" } }]);
  });

  it("chips an assistant turn that is just a bare known tool name (verbatim live shape)", () => {
    expect(splitAssistantMessage("Observe")).toEqual([{ kind: "chip", chip: { name: "Observe" } }]);
    // …but ordinary one-word prose stays prose.
    expect(splitAssistantMessage("Hello")).toEqual([{ kind: "prose", text: "Hello" }]);
  });

  it("chips plain-text call blocks — bare tool-name line + key: value arg lines (verbatim live shape)", () => {
    const segs = splitAssistantMessage(
      "Sure thing! Let me walk north for you. 😊\n\n" +
        "MoveSelf\ndestination: North, approximately 3 steps forward\ndescription: Walking three steps northward across the terrain\n\n" +
        "PlayAnimation\nanimation: wave\n\n" +
        "You got it — three steps north and a friendly wave hello! 🌿",
    );
    expect(segs).toEqual([
      { kind: "prose", text: "Sure thing! Let me walk north for you. 😊" },
      { kind: "chip", chip: { name: "MoveSelf", summary: "destination North, approximatel…, description Walking three…" } },
      { kind: "chip", chip: { name: "PlayAnimation", summary: "animation wave" } },
      { kind: "prose", text: "You got it — three steps north and a friendly wave hello! 🌿" },
    ]);
  });

  it("chips an inline key:value call line but not prose starting with a tool word (verbatim live shape)", () => {
    const segs = splitAssistantMessage(
      "Observe\n\nI see a beautiful landscape with rolling hills.\n\nMoveSelf direction:north distance:5\n\nAfter moving a few steps north, I can see more.",
    );
    expect(segs).toEqual([
      { kind: "chip", chip: { name: "Observe", summary: undefined } },
      { kind: "prose", text: "I see a beautiful landscape with rolling hills." },
      { kind: "chip", chip: { name: "MoveSelf", summary: "direction north, distance 5" } },
      { kind: "prose", text: "After moving a few steps north, I can see more." },
    ]);
    // A sentence that merely STARTS with a tool word stays prose.
    expect(splitAssistantMessage("Look at that gorgeous sunset!")).toEqual([
      { kind: "prose", text: "Look at that gorgeous sunset!" },
    ]);
  });

  it("does NOT chip arbitrary JSON that is not a tool call", () => {
    const text = 'The config is {"radius": 30} if you were wondering.';
    expect(splitAssistantMessage(text)).toEqual([{ kind: "prose", text }]);
  });

  it("drops an unidentifiable call block instead of rendering it raw", () => {
    expect(splitAssistantMessage("<tool_call_box>\ngarbage that is not a call\n</tool_call_box>")).toEqual([]);
  });
});

describe("parseToolCallObject", () => {
  it("reads the action-style shape", () => {
    expect(
      parseToolCallObject('{"action":"SculptTerrain","operation":"raise","radius":3,"strength":0.5}'),
    ).toEqual({ name: "SculptTerrain", summary: "operation raise, radius 3, strength 0.5" });
  });

  it("returns null for non-call JSON", () => {
    expect(parseToolCallObject('{"radius": 30}')).toBeNull();
  });
});

describe("summarizeToolArgs", () => {
  it("is undefined for empty shapes", () => {
    expect(summarizeToolArgs(undefined)).toBeUndefined();
    expect(summarizeToolArgs({})).toBeUndefined();
    expect(summarizeToolArgs("{}")).toBeUndefined();
  });

  it("renders prompt-like keys bare and quoted", () => {
    expect(summarizeToolArgs({ prompt: "a small fox" })).toBe('"a small fox"');
  });

  it("caps at three entries and ~60 chars", () => {
    const s = summarizeToolArgs({ a: 1, b: 2, c: 3, d: 4 });
    expect(s).toBe("a 1, b 2, c 3");
    const long = summarizeToolArgs({ prompt: "x".repeat(200) });
    expect((long ?? "").length).toBeLessThanOrEqual(60);
  });
});

describe("buildAgentFeed", () => {
  const line = (id: number, who: AgentChatLine["who"], text: string): AgentChatLine => ({ id, who, text });

  it("collapses runs of ≥3 consecutive chips into one group, leaves shorter runs alone", () => {
    const feed = buildAgentFeed([
      line(1, "you", "go explore"),
      line(2, "agent", '{"action":"Observe"}'),
      line(3, "tool", "look: a meadow"),
      line(4, "agent", '{\n  "tool": "MoveSelf",\n  "parameters": {\n    "north": 3\n  }\n}'),
      line(5, "agent", "What a lovely meadow!"),
      line(6, "tool", "rejected: too far"),
      line(7, "tool", "remembered. ok"),
    ]);
    expect(feed.map((i) => i.kind)).toEqual(["prose", "chipGroup", "prose", "chip", "chip"]);
    const group = feed[1] as Extract<(typeof feed)[number], { kind: "chipGroup" }>;
    expect(group.chips.map((c) => c.chip.name)).toEqual(["Observe", "Look", "MoveSelf"]);
  });

  it("splits an assistant line into prose + chip and keeps system notes as prose", () => {
    const feed = buildAgentFeed([
      line(1, "system", "— thread reset —"),
      line(2, "agent", 'On my way!\n\n{"action":"MoveSelf","direction":"forward","distance":2}'),
    ]);
    expect(feed).toEqual([
      { kind: "prose", key: "1", who: "system", text: "— thread reset —" },
      { kind: "prose", key: "2:0", who: "agent", text: "On my way!" },
      { kind: "chip", key: "2:1", chip: { name: "MoveSelf", summary: "direction forward, distance 2" } },
    ]);
  });
});

describe("describeToolResult", () => {
  it("recognizes the Observe view blob", () => {
    expect(
      describeToolResult('{"position":{"x":1,"y":0,"z":2},"terrain":"meadow","nearby":[]}'),
    ).toEqual({ name: "Observe" });
  });

  it("humanizes TellusPatch result types", () => {
    expect(describeToolResult('{"type":"asset.generate.queued","prompt":"a small fox"}')).toEqual({
      name: "Generate queued",
      summary: '"a small fox"',
    });
    expect(describeToolResult('{"type":"action.rejected","reason":"rate limited"}')).toEqual({
      name: "Rejected",
      summary: "rate limited",
    });
  });

  it("maps the short server sentences", () => {
    expect(describeToolResult("rejected: too far away")).toEqual({ name: "Rejected", summary: "too far away" });
    expect(describeToolResult("remembered. Your durable memory is now 312 chars.")).toEqual({ name: "Remember" });
    expect(describeToolResult("look: a beach with two visitors to the north")).toEqual({
      name: "Look",
      summary: "a beach with two visitors to the north",
    });
    expect(
      describeToolResult("You have already observed this turn — do NOT observe again."),
    ).toEqual({ name: "Observe", summary: "already observed this turn" });
    expect(describeToolResult("generate is unavailable (no world in scope).")).toEqual({
      name: "Generate",
      summary: "unavailable",
    });
  });

  it("clips unknown text to a noise-stripped first line", () => {
    const chip = describeToolResult("Some long unstructured tool output\nwith a second line");
    expect(chip.name).toBe("Tool");
    expect(chip.summary).toBe("Some long unstructured tool output");
  });
});
