/**
 * Waiting for the *next* code on a line.
 *
 * The hard part is not the polling, it is refusing to return a code that was
 * already sitting in the inbox. `armLine` reads the newest message the line has
 * and keeps its `receivedAt` as a cursor; the wait then only ever considers
 * messages strictly after that moment. The cursor is a server timestamp, so a
 * local clock that is ahead or behind cannot widen or narrow the window.
 */

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record where a line's inbox stands right now, before the thing that triggers
 * the text. Everything already received is excluded from the wait that follows.
 *
 * @returns {Promise<{lineId: string, cursor: string|null, seenIds: string[]}>}
 */
export async function armLine(client, lineId) {
  const newest = await client.listMessages(lineId, { limit: 1 });
  const latest = newest[0];
  return {
    lineId,
    cursor: latest ? latest.receivedAt : null,
    seenIds: latest ? [latest.id] : [],
  };
}

/** Does this message look like the one we are waiting for? */
export function messageMatches(message, { from, service, bodyPattern, requireCode = true } = {}) {
  if (requireCode && !message.code) return false;

  if (from) {
    const sender = String(message.from ?? "").toLowerCase();
    if (!sender.includes(String(from).toLowerCase())) return false;
  }

  if (service) {
    const wanted = String(service).toLowerCase();
    const candidates = [message.service?.id, message.service?.name, message.label]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    if (!candidates.some((value) => value === wanted || value.includes(wanted))) return false;
  }

  if (bodyPattern) {
    const pattern = bodyPattern instanceof RegExp ? bodyPattern : new RegExp(bodyPattern, "i");
    if (!pattern.test(String(message.body ?? ""))) return false;
  }

  return true;
}

/**
 * Poll a line until a matching message arrives, or the timeout runs out.
 *
 * @param {object} client            from createClient()
 * @param {object} options
 * @param {string} options.lineId
 * @param {string|null} [options.cursor]   From armLine(). Null means "the inbox was empty".
 * @param {string[]} [options.seenIds]     From armLine().
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollIntervalMs]
 * @param {string} [options.from]          Case-insensitive substring of the sender.
 * @param {string} [options.service]       Matched against service.id, service.name and label.
 * @param {string|RegExp} [options.bodyPattern]
 * @param {boolean} [options.requireCode]  Default true: only messages with an extracted code.
 * @param {() => number} [options.now]     Injected in tests.
 * @param {(ms: number) => Promise<void>} [options.sleep]  Injected in tests.
 * @returns {Promise<{found: true, code: string|null, message: object, waitedMs: number}
 *                 | {found: false, timedOut: true, waitedMs: number}>}
 */
export async function waitForCode(client, options) {
  const {
    lineId,
    cursor = null,
    seenIds = [],
    timeoutMs = 60_000,
    pollIntervalMs = 2_000,
    from,
    service,
    bodyPattern,
    requireCode = true,
    now = () => Date.now(),
    sleep = sleepDefault,
  } = options;

  if (!lineId) throw new Error("waitForCode needs a lineId.");

  const filters = { from, service, bodyPattern, requireCode };
  const startedAt = now();
  const seen = new Set(seenIds);
  let position = cursor;

  for (;;) {
    let messages;
    try {
      messages = await client.listMessages(lineId, {
        after: position ?? undefined,
        limit: 200,
      });
    } catch (error) {
      // 429 is worth waiting out; anything else is a real problem (a bad key,
      // a line outside the key's scope, an unverified owner) and should surface.
      if (error?.status !== 429) throw error;
      messages = null;
    }

    if (messages) {
      // `after` gives oldest first; without it the API gives newest first.
      const ordered = position ? messages : [...messages].reverse();

      for (const message of ordered) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (messageMatches(message, filters)) {
          return { found: true, code: message.code ?? null, message, waitedMs: now() - startedAt };
        }
      }

      const last = ordered[ordered.length - 1];
      if (last && (!position || last.receivedAt > position)) position = last.receivedAt;
    }

    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      return { found: false, timedOut: true, waitedMs: elapsed };
    }
    await sleep(Math.max(0, Math.min(pollIntervalMs, timeoutMs - elapsed)));
  }
}

/** The most recent code already on a line, if there is one. */
export async function latestCode(client, { lineId, from, service, bodyPattern } = {}) {
  const messages = await client.listMessages(lineId, { limit: 50 });
  for (const message of messages) {
    if (messageMatches(message, { from, service, bodyPattern, requireCode: true })) {
      return { found: true, code: message.code, message };
    }
  }
  return { found: false };
}
