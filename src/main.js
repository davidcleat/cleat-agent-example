#!/usr/bin/env node
/**
 * Run the example.
 *
 *   ANTHROPIC_API_KEY=...        the Claude API key
 *   CLEAT_API_KEY=clt_...        scoped to one line, with an expiry
 *   CLEAT_LINE_ID=...            the line the agent is pinned to
 *   SIGN_IN_CALLBACK_URL=...     where the code may be submitted (optional)
 *
 *   node src/main.js "I'm about to press Send code on my own Shopify login.
 *                     Wait for the text and submit it."
 *
 * This calls the Claude API, which costs money, and reads a real line.
 */

import { createClient } from "./client.js";
import { createTools } from "./tools.js";
import { runAgent } from "./agent.js";

const {
  ANTHROPIC_API_KEY,
  CLEAT_API_KEY,
  CLEAT_LINE_ID,
  SIGN_IN_CALLBACK_URL,
} = process.env;

const showCode = process.argv.includes("--show-code");
const task =
  process.argv.slice(2).filter((argument) => !argument.startsWith("--")).join(" ") ||
  "I am about to trigger the verification text on my own account's sign-in. " +
    "Wait for the code on my line and submit it to the sign-in I started.";

const missing = [
  !ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
  !CLEAT_API_KEY && "CLEAT_API_KEY",
  !CLEAT_LINE_ID && "CLEAT_LINE_ID",
].filter(Boolean);

if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. See .env.example.`);
  process.exit(1);
}

const { default: Anthropic } = await import("@anthropic-ai/sdk");

const tools = createTools({
  client: createClient({ apiKey: CLEAT_API_KEY }),
  // The agent is pinned here, in the owner's own code, on top of the scope the
  // API key already has.
  allowedLineId: CLEAT_LINE_ID,
  signInCallbackUrl: SIGN_IN_CALLBACK_URL,
});

/** Hide the code in the transcript unless the owner asked to see it. */
function redact(value) {
  if (showCode) return value;
  return JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === "code" && typeof entry === "string" ? "•".repeat(entry.length) : entry,
    ),
  );
}

const result = await runAgent({
  anthropic: new Anthropic({ apiKey: ANTHROPIC_API_KEY }),
  tools,
  task,
  onEvent(event) {
    switch (event.type) {
      case "text":
        console.log(`\n${event.text}\n`);
        break;
      case "tool_call":
        console.log(`  -> ${event.name}(${JSON.stringify(redact(event.input ?? {}))})`);
        break;
      case "tool_result":
        console.log(
          `  <- ${event.isError ? "refused/failed" : "ok"} ${JSON.stringify(redact(event.result))}`,
        );
        break;
      case "refusal":
        console.log("  !! the model declined this request");
        break;
      default:
        break;
    }
  },
});

console.log(
  `\nFinished after ${result.turns} turn(s): ${result.stopReason}. ` +
    `${result.toolCalls.length} tool call(s).`,
);
if (!showCode) console.log("Codes are hidden in this transcript. Pass --show-code to see them.");
