/**
 * The agent's entire world.
 *
 * Four tools. Three of them read one line on a Cleat workspace; the fourth hands
 * the code to the sign-in its owner already started, at a URL the owner
 * configured before the agent ran. There is nothing here that browses, that
 * sends a text, that creates an account, or that picks its own destination for a
 * code — and the refusals below are enforced in this file, not asked for in a
 * prompt.
 *
 * The API key should be scoped to the one line and given an expiry when it is
 * created, so the boundary holds even if this code is wrong.
 */

import { armLine, waitForCode } from "./watch.js";

export const MAX_WAIT_SECONDS = 180;

/** What the model is told it can do. */
export const toolDefinitions = [
  {
    name: "list_lines",
    description:
      "List the Cleat lines this agent's API key can reach. Use it to confirm the line you are allowed to read. Returns the phone number, label and status.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_recent_messages",
    description:
      "Read the last few texts and transcribed calls already on the line. Use this to see what the account sent before, or to check a code you missed. Do not use it to pick up a code for a sign-in that is in progress — use wait_for_code, which refuses stale codes.",
    input_schema: {
      type: "object",
      properties: {
        lineId: { type: "string", description: "The line id from list_lines." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
      },
      required: ["lineId"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_code",
    description:
      "Wait for the NEXT verification code to arrive on the line and return it. A code that was already in the inbox is never returned, so this is the only safe way to get the code for a sign-in in progress. Returns found: false if nothing arrives in time, which is an ordinary result you can retry.",
    input_schema: {
      type: "object",
      properties: {
        lineId: { type: "string", description: "The line id from list_lines." },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          description: `How long to wait, up to ${MAX_WAIT_SECONDS}. Default 60.`,
        },
      },
      required: ["lineId"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_verification_code",
    description:
      "Hand the code to the sign-in the owner already started. You cannot choose where it goes: the destination was configured by the owner before you ran. Call this once, with the code you just received.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code exactly as it arrived." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
];

/** A refusal the model can read and act on, rather than a crash. */
function refuse(reason) {
  return { refused: true, reason };
}

/**
 * @param {object} options
 * @param {object} options.client              a Cleat client from createClient()
 * @param {string} options.allowedLineId       the one line this agent may read
 * @param {string} [options.signInCallbackUrl] where the code may be submitted
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.pollIntervalMs]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export function createTools({
  client,
  allowedLineId,
  signInCallbackUrl,
  fetch: fetchImpl,
  pollIntervalMs = 2_000,
  now,
  sleep,
}) {
  if (!allowedLineId) {
    throw new Error(
      "createTools needs allowedLineId: the agent has to be pinned to one line before it runs.",
    );
  }

  let submissions = 0;

  function checkLine(lineId) {
    if (lineId === allowedLineId) return null;
    return refuse(
      `This agent may only read line ${allowedLineId}. It was asked for ${lineId ?? "no line at all"}. ` +
        "The API key is scoped to the allowed line as well, so another line would answer 404 in any case.",
    );
  }

  const handlers = {
    async list_lines() {
      const lines = await client.listLines();
      // Only the line this agent is pinned to, even if the key could see more.
      return {
        lines: lines
          .filter((line) => line.id === allowedLineId)
          .map((line) => ({
            id: line.id,
            phone: line.phone,
            label: line.label ?? null,
            status: line.status,
          })),
        note: `This agent is pinned to line ${allowedLineId}.`,
      };
    },

    async read_recent_messages({ lineId, limit = 5 } = {}) {
      const refusal = checkLine(lineId);
      if (refusal) return refusal;

      const bounded = Math.min(20, Math.max(1, Number(limit) || 5));
      const messages = await client.listMessages(lineId, { limit: bounded });
      return {
        messages: messages.map((entry) => ({
          from: entry.from,
          body: entry.body,
          code: entry.code ?? null,
          receivedAt: entry.receivedAt,
          label: entry.label ?? null,
        })),
      };
    },

    async wait_for_code({ lineId, timeoutSeconds = 60 } = {}) {
      const refusal = checkLine(lineId);
      if (refusal) return refusal;

      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(timeoutSeconds) || 60));

      // Read the inbox before waiting, so a code from an earlier sign-in can
      // never be handed to this one.
      const armed = await armLine(client, lineId);
      const result = await waitForCode(client, {
        ...armed,
        timeoutMs: seconds * 1_000,
        pollIntervalMs,
        now,
        sleep,
      });

      if (!result.found) {
        return {
          found: false,
          timedOut: true,
          reason:
            `No new code arrived within ${seconds}s. Only messages received after ` +
            `${armed.cursor ?? "the moment this wait started"} count. Ask the owner to ` +
            "send the code again, or report back that it never arrived.",
        };
      }
      return {
        found: true,
        code: result.message.code,
        body: result.message.body,
        from: result.message.from,
        receivedAt: result.message.receivedAt,
      };
    },

    async submit_verification_code({ code } = {}) {
      if (!signInCallbackUrl) {
        return refuse(
          "No sign-in destination was configured, so there is nowhere to submit a code. " +
            "Report the code to the owner instead and stop.",
        );
      }
      if (typeof code !== "string" || !/^[0-9A-Za-z][0-9A-Za-z -]{2,15}$/.test(code.trim())) {
        return refuse(
          "That does not look like a verification code. Submit the code exactly as it arrived, and nothing else.",
        );
      }
      if (submissions >= 1) {
        return refuse(
          "A code has already been submitted for this run. One sign-in, one code: stop and report what happened.",
        );
      }

      submissions += 1;
      const doFetch = fetchImpl ?? globalThis.fetch;
      const response = await doFetch(signInCallbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });

      return {
        submitted: true,
        // The destination is echoed so the owner's transcript shows where it went.
        destination: signInCallbackUrl,
        status: response.status,
        ok: response.ok,
      };
    },
  };

  return { toolDefinitions, handlers };
}
