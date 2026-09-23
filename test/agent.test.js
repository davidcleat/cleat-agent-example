/**
 * The loop, against a scripted stand-in for the Anthropic client. No network,
 * no Claude API key, no tokens spent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL, SYSTEM_PROMPT, runAgent } from "../src/agent.js";

/** Replays the turns you give it, and records what it was asked. */
function scriptedClient(turns) {
  const requests = [];
  let index = 0;
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          // The loop appends to its own messages array as it goes, so snapshot
          // what each request actually carried.
          requests.push(structuredClone(params));
          const turn = turns[index++];
          if (!turn) throw new Error("the loop asked for more turns than the script has");
          return {
            id: `msg_${index}`,
            model: MODEL,
            stop_reason: turn.stop_reason ?? (turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
            stop_details: turn.stop_details ?? null,
            content: turn.content,
          };
        },
      },
    },
  };
}

function toolUse(id, name, input) {
  return { type: "tool_use", id, name, input };
}

/** A tool set that records calls, so the loop can be tested on its own. */
function fakeTools(handlers) {
  const calls = [];
  return {
    calls,
    toolDefinitions: Object.keys(handlers).map((name) => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    })),
    handlers: Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        async (input) => {
          calls.push({ name, input });
          return handler(input);
        },
      ]),
    ),
  };
}

test("a normal run: wait for the code, submit it, report back", async () => {
  const tools = fakeTools({
    wait_for_code: async () => ({ found: true, code: "704118", body: "704118 is your code" }),
    submit_verification_code: async () => ({ submitted: true, status: 204, ok: true }),
  });

  const anthropic = scriptedClient([
    {
      content: [
        // A thinking block with no visible text, as the current models return.
        { type: "thinking", thinking: "", signature: "sig" },
        toolUse("t1", "wait_for_code", { lineId: "line-1", timeoutSeconds: 120 }),
      ],
    },
    { content: [toolUse("t2", "submit_verification_code", { code: "704118" })] },
    { content: [{ type: "text", text: "Submitted the code; the sign-in went through." }] },
  ]);

  const result = await runAgent({ anthropic, tools, task: "finish my sign-in" });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.turns, 3);
  assert.match(result.text, /Submitted the code/);
  assert.deepEqual(tools.calls.map((call) => call.name), [
    "wait_for_code",
    "submit_verification_code",
  ]);
});

test("each turn replays the assistant content unchanged and answers every tool_use", async () => {
  const tools = fakeTools({
    wait_for_code: async () => ({ found: true, code: "704118" }),
  });
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const anthropic = scriptedClient([
    { content: [thinking, toolUse("t1", "wait_for_code", { lineId: "line-1" })] },
    { content: [{ type: "text", text: "done" }] },
  ]);

  await runAgent({ anthropic, tools, task: "finish my sign-in" });

  const second = anthropic.requests[1];
  assert.equal(second.messages[0].role, "user");
  // The assistant turn is echoed byte for byte, thinking block included.
  assert.deepEqual(second.messages[1], {
    role: "assistant",
    content: [thinking, toolUse("t1", "wait_for_code", { lineId: "line-1" })],
  });
  // ...and the tool results come back in one user message, keyed by tool_use_id.
  assert.equal(second.messages[2].role, "user");
  assert.equal(second.messages[2].content.length, 1);
  assert.equal(second.messages[2].content[0].tool_use_id, "t1");
  assert.equal(second.messages[2].content[0].is_error, false);
  assert.deepEqual(JSON.parse(second.messages[2].content[0].content), {
    found: true,
    code: "704118",
  });
});

test("parallel tool calls are all answered, in a single user message", async () => {
  const tools = fakeTools({
    list_lines: async () => ({ lines: [] }),
    wait_for_code: async () => ({ found: false, timedOut: true }),
  });
  const anthropic = scriptedClient([
    {
      content: [
        toolUse("a", "list_lines", {}),
        toolUse("b", "wait_for_code", { lineId: "line-1" }),
      ],
    },
    { content: [{ type: "text", text: "nothing arrived" }] },
  ]);

  await runAgent({ anthropic, tools, task: "finish my sign-in" });

  const results = anthropic.requests[1].messages[2].content;
  assert.deepEqual(results.map((entry) => entry.tool_use_id), ["a", "b"]);
});

test("a refused tool comes back as an error result the model can recover from", async () => {
  const tools = fakeTools({
    read_recent_messages: async () => ({
      refused: true,
      reason: "This agent may only read line line-1.",
    }),
    wait_for_code: async () => ({ found: true, code: "704118" }),
  });

  const anthropic = scriptedClient([
    { content: [toolUse("t1", "read_recent_messages", { lineId: "someone-elses-line" })] },
    { content: [toolUse("t2", "wait_for_code", { lineId: "line-1" })] },
    { content: [{ type: "text", text: "I can only read the line I am pinned to." }] },
  ]);

  const result = await runAgent({ anthropic, tools, task: "read another line" });

  const refusal = anthropic.requests[1].messages[2].content[0];
  assert.equal(refusal.is_error, true);
  assert.match(refusal.content, /may only read line/);
  // The run continued, so the model could correct itself.
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.toolCalls.length, 2);
});

test("a tool that throws is reported to the model, not to a crash log", async () => {
  const failure = Object.assign(new Error("This key has expired."), {
    status: 401,
    code: "key_expired",
  });
  const tools = fakeTools({
    wait_for_code: async () => {
      throw failure;
    },
  });
  const anthropic = scriptedClient([
    { content: [toolUse("t1", "wait_for_code", { lineId: "line-1" })] },
    { content: [{ type: "text", text: "The key has expired; please issue a new one." }] },
  ]);

  const result = await runAgent({ anthropic, tools, task: "finish my sign-in" });

  const toolResult = anthropic.requests[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.deepEqual(JSON.parse(toolResult.content), {
    error: "This key has expired.",
    status: 401,
    code: "key_expired",
  });
  assert.equal(result.stopReason, "end_turn");
});

test("a tool name that does not exist is answered, not invented", async () => {
  const tools = fakeTools({ wait_for_code: async () => ({ found: false }) });
  const anthropic = scriptedClient([
    { content: [toolUse("t1", "send_text", { to: "13055550100", body: "hello" })] },
    { content: [{ type: "text", text: "There is no way to send a text from this line." }] },
  ]);

  await runAgent({ anthropic, tools, task: "text someone" });

  const toolResult = anthropic.requests[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /no tool called send_text/);
});

test("a policy decline stops the run and is reported", async () => {
  const tools = fakeTools({ wait_for_code: async () => ({ found: true, code: "1" }) });
  const anthropic = scriptedClient([
    { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "other" } },
  ]);

  const result = await runAgent({ anthropic, tools, task: "something the model declines" });

  assert.equal(result.stopReason, "refusal");
  assert.equal(result.toolCalls.length, 0);
});

test("the loop cannot run away: maxTurns ends it", async () => {
  const tools = fakeTools({ wait_for_code: async () => ({ found: false, timedOut: true }) });
  const anthropic = scriptedClient(
    Array.from({ length: 10 }, (_, index) => ({
      content: [toolUse(`t${index}`, "wait_for_code", { lineId: "line-1" })],
    })),
  );

  const result = await runAgent({ anthropic, tools, task: "loop forever", maxTurns: 3 });

  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.turns, 3);
  assert.equal(anthropic.requests.length, 3);
});

test("the request carries the model, the tools and the system prompt's boundaries", async () => {
  const tools = fakeTools({ wait_for_code: async () => ({ found: true, code: "1" }) });
  const anthropic = scriptedClient([{ content: [{ type: "text", text: "ok" }] }]);

  await runAgent({ anthropic, tools, task: "finish my sign-in" });

  const request = anthropic.requests[0];
  assert.equal(request.model, MODEL);
  assert.equal(request.system, SYSTEM_PROMPT);
  assert.deepEqual(request.tools, tools.toolDefinitions);
  assert.deepEqual(request.messages, [{ role: "user", content: "finish my sign-in" }]);
  assert.equal(request.fallbacks, "default");
});

test("the system prompt states the boundaries the code enforces", () => {
  for (const phrase of [
    "account they already hold",
    "refuse",
    "create an account",
    "receive-only",
    "earlier sign-in",
  ]) {
    assert.ok(
      SYSTEM_PROMPT.toLowerCase().includes(phrase.toLowerCase()),
      `the system prompt never says "${phrase}"`,
    );
  }
});
