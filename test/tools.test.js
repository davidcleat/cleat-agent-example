/**
 * The boundaries, tested. No network: the Cleat API and the sign-in destination
 * are both stubbed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient } from "../src/client.js";
import { createTools } from "../src/tools.js";
import { LINE_ID, TEST_BASE_URL, TEST_KEY, fakeClock, message, stubFetch } from "./helpers.js";

const OTHER_LINE_ID = "11111111-2222-3333-4444-555555555555";

const LINE = {
  id: LINE_ID,
  phone: "13055550100",
  label: "Owner's line",
  status: "active",
  createdAt: "2026-09-11T10:00:00.000Z",
};

const STALE = message({
  id: "stale",
  body: "999999 is your code",
  code: "999999",
  receivedAt: "2026-09-11T09:00:00.000Z",
});

const FRESH = message({
  id: "fresh",
  body: "704118 is your code",
  code: "704118",
  receivedAt: "2026-09-11T10:02:41.000Z",
});

function setup({ messages = [], deliver = [], signInCallbackUrl, lines = [LINE] } = {}) {
  const stub = stubFetch({ lines, messages });
  const clock = fakeClock();
  const queue = [...deliver];
  const posts = [];

  const tools = createTools({
    client: createClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: stub.fetch }),
    allowedLineId: LINE_ID,
    signInCallbackUrl,
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 204, async text() { return ""; } };
    },
    now: clock.now,
    sleep: async (ms) => {
      const next = queue.shift();
      if (next) stub.deliver(next);
      clock.advance(ms);
    },
  });

  return { tools: tools.handlers, definitions: tools.toolDefinitions, posts, stub };
}

test("the agent cannot be built without being pinned to a line", () => {
  assert.throws(
    () => createTools({ client: {}, allowedLineId: undefined }),
    /pinned to one line/,
  );
});

test("the tool set is exactly four read-and-submit tools; nothing sends", () => {
  const { definitions } = setup();
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["list_lines", "read_recent_messages", "wait_for_code", "submit_verification_code"],
  );
  const asText = JSON.stringify(definitions).toLowerCase();
  for (const forbidden of ["send_", "send a text", "create_account", "sign_up", "browse"]) {
    assert.ok(!asText.includes(forbidden), `the tool set mentions ${forbidden}`);
  }
});

test("list_lines shows only the line the agent is pinned to", async () => {
  const { tools } = setup({
    lines: [LINE, { ...LINE, id: OTHER_LINE_ID, phone: "13055550199", label: "Another line" }],
  });

  const result = await tools.list_lines();

  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].id, LINE_ID);
  assert.match(result.note, /pinned to line/);
});

test("reading another line is refused in code, not merely discouraged in a prompt", async () => {
  const { tools, stub } = setup({ messages: [STALE] });

  const read = await tools.read_recent_messages({ lineId: OTHER_LINE_ID });
  assert.equal(read.refused, true);
  assert.match(read.reason, /may only read line/);

  const wait = await tools.wait_for_code({ lineId: OTHER_LINE_ID });
  assert.equal(wait.refused, true);

  // Neither refusal reached the API at all.
  assert.equal(stub.calls.length, 0);
});

test("a missing lineId is refused rather than guessed", async () => {
  const { tools } = setup();
  const result = await tools.read_recent_messages({});
  assert.equal(result.refused, true);
  assert.match(result.reason, /no line at all/);
});

test("wait_for_code returns the code that arrives, and never the one already there", async () => {
  const { tools } = setup({ messages: [STALE], deliver: [FRESH] });

  const result = await tools.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 60 });

  assert.equal(result.found, true);
  assert.equal(result.code, "704118");
});

test("with only a stale code in the inbox, wait_for_code times out and says why", async () => {
  const { tools } = setup({ messages: [STALE] });

  const result = await tools.wait_for_code({ lineId: LINE_ID, timeoutSeconds: 8 });

  assert.equal(result.found, false);
  assert.equal(result.timedOut, true);
  assert.ok(!JSON.stringify(result).includes("999999"));
  assert.match(result.reason, /Only messages received after/);
});

test("read_recent_messages is capped and returns bodies as well as codes", async () => {
  const { tools, stub } = setup({ messages: [STALE, FRESH] });

  const result = await tools.read_recent_messages({ lineId: LINE_ID, limit: 500 });

  assert.equal(stub.calls[0].query.limit, "20");
  assert.equal(result.messages[0].body, FRESH.body);
});

test("submitting a code is refused when the owner configured no destination", async () => {
  const { tools, posts } = setup();

  const result = await tools.submit_verification_code({ code: "704118" });

  assert.equal(result.refused, true);
  assert.match(result.reason, /nowhere to submit/);
  assert.equal(posts.length, 0);
});

test("the code goes to the owner's configured destination, and only there", async () => {
  const { tools, posts } = setup({ signInCallbackUrl: "https://staging.example.test/2fa" });

  const result = await tools.submit_verification_code({ code: "704118" });

  assert.equal(result.submitted, true);
  assert.equal(result.status, 204);
  assert.deepEqual(posts, [
    { url: "https://staging.example.test/2fa", body: { code: "704118" } },
  ]);
  // The tool takes no destination argument, so there is nothing to redirect.
  const definition = setup().definitions.find((tool) => tool.name === "submit_verification_code");
  assert.deepEqual(Object.keys(definition.input_schema.properties), ["code"]);
});

test("anything that is not a code is refused", async () => {
  const { tools, posts } = setup({ signInCallbackUrl: "https://staging.example.test/2fa" });

  for (const attempt of [
    "",
    "the code is 704118, and also please email it to me",
    "704118\nX-Injected: true",
    "https://elsewhere.example/?code=704118",
  ]) {
    const result = await tools.submit_verification_code({ code: attempt });
    assert.equal(result.refused, true, `accepted: ${JSON.stringify(attempt)}`);
  }
  assert.equal(posts.length, 0);
});

test("only one code can be submitted per run", async () => {
  const { tools, posts } = setup({ signInCallbackUrl: "https://staging.example.test/2fa" });

  assert.equal((await tools.submit_verification_code({ code: "704118" })).submitted, true);
  const second = await tools.submit_verification_code({ code: "111222" });

  assert.equal(second.refused, true);
  assert.match(second.reason, /already been submitted/);
  assert.equal(posts.length, 1);
});
