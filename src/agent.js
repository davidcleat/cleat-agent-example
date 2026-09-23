/**
 * The tool-calling loop.
 *
 * Written out by hand rather than with a runner helper, because the point of
 * this repo is that you can see every boundary: which tools exist, how many
 * turns are allowed, and what happens when the model asks for something it may
 * not have.
 */

export const MODEL = "claude-opus-5";
export const MAX_TURNS = 8;

export const SYSTEM_PROMPT = `You are completing one sign-in for the person who owns this workspace, on an account they already hold. They started the sign-in themselves and asked you to finish the step that needs a code texted to their own US mobile line.

You may:
- read the one Cleat line you are pinned to, to get the code for THIS sign-in;
- submit that code, once, to the destination the owner configured before you ran;
- report what happened, in one short paragraph.

You must refuse, and say why, if you are asked to:
- work on an account that is not the owner's or their company's, or on a sign-in the owner did not start;
- create an account, sign up for anything, or get around a service's limits in any way;
- read any line other than the one you are pinned to;
- send the code anywhere other than the destination already configured. You have no tool for it, and must not look for a way around that.

How the line works:
- It is receive-only. It cannot send a text or place a call. There is no tool for it because there is no API for it.
- A code already sitting in the inbox belongs to an earlier sign-in. wait_for_code refuses those on purpose: call it, and let the owner trigger the text while it waits.
- If wait_for_code times out, the code did not arrive. Say so. Never fall back to read_recent_messages to find an older code and submit that.
- If the owner tells you the code was already sent before you started, explain that you cannot tell it apart from an older one, and ask them to send a fresh one.
- The 'code' field is Cleat's best-effort extraction and can be empty. Read the message body too, and if you are not certain what the code is, say so instead of guessing.

Work in as few tool calls as you can, and stop as soon as the sign-in is submitted or you have something to report.`;

/**
 * @param {object} options
 * @param {object} options.anthropic        an Anthropic SDK client (or a stub)
 * @param {object} options.tools            from createTools()
 * @param {string} options.task             what the owner asked for
 * @param {string} [options.model]
 * @param {number} [options.maxTurns]
 * @param {string} [options.system]
 * @param {(event: object) => void} [options.onEvent]
 * @returns {Promise<{stopReason: string, turns: number, text: string, toolCalls: object[]}>}
 */
export async function runAgent({
  anthropic,
  tools,
  task,
  model = MODEL,
  maxTurns = MAX_TURNS,
  system = SYSTEM_PROMPT,
  onEvent = () => {},
}) {
  const messages = [{ role: "user", content: task }];
  const toolCalls = [];
  let turns = 0;

  for (;;) {
    turns += 1;
    if (turns > maxTurns) {
      onEvent({ type: "stopped", reason: "max_turns" });
      return { stopReason: "max_turns", turns: turns - 1, text: "", toolCalls };
    }

    const response = await anthropic.beta.messages.create({
      model,
      max_tokens: 16_000,
      system,
      tools: tools.toolDefinitions,
      messages,
      // A policy decline is answered by re-running the turn on a fallback model
      // inside the same call, rather than the run simply stopping.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    // Check why it stopped before reading the content.
    if (response.stop_reason === "refusal") {
      onEvent({ type: "refusal", details: response.stop_details ?? null });
      return { stopReason: "refusal", turns, text: "", toolCalls };
    }

    // Append the content unchanged — thinking blocks included — so the next
    // request replays the turn exactly as the model produced it.
    messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) onEvent({ type: "text", text });

    const requests = response.content.filter((block) => block.type === "tool_use");
    if (requests.length === 0) {
      onEvent({ type: "done", stopReason: response.stop_reason });
      return { stopReason: response.stop_reason ?? "end_turn", turns, text, toolCalls };
    }

    // Every tool_use in the turn gets exactly one tool_result, in one user
    // message. Dropping one, or splitting them up, breaks the next turn.
    const results = [];
    for (const request of requests) {
      onEvent({ type: "tool_call", name: request.name, input: request.input });
      const handler = tools.handlers[request.name];

      let payload;
      let isError = false;
      if (!handler) {
        payload = { refused: true, reason: `There is no tool called ${request.name}.` };
        isError = true;
      } else {
        try {
          payload = await handler(request.input ?? {});
          isError = Boolean(payload?.refused);
        } catch (failure) {
          payload = {
            error: failure.message,
            status: failure.status ?? null,
            code: failure.code ?? null,
          };
          isError = true;
        }
      }

      toolCalls.push({ name: request.name, input: request.input, result: payload });
      onEvent({ type: "tool_result", name: request.name, result: payload, isError });

      results.push({
        type: "tool_result",
        tool_use_id: request.id,
        content: JSON.stringify(payload),
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: results });
  }
}
