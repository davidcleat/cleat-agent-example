/**
 * A stub of the two Cleat endpoints. No network, no keys: the "key" below is a
 * literal placeholder and the base URL is never dialled.
 */

export const TEST_KEY = "clt_test_placeholder_not_a_real_key";
export const TEST_BASE_URL = "https://cleat.test";
export const LINE_ID = "8f14e45f-ceea-4b6b-9d3c-2a1f0e7c5b10";

export function message({ id, from = "32665", body, code = null, receivedAt, service = null, label = null }) {
  return {
    id,
    line: { id: LINE_ID, phone: "13055550100", label: "Staging sign-ups" },
    from,
    body,
    code,
    receivedAt,
    service,
    contact: null,
    label,
  };
}

/**
 * Builds a fetch() that answers the Cleat routes from an in-memory inbox.
 *
 * @param {object} options
 * @param {Array} [options.lines]
 * @param {Array} [options.messages]   Any order; the stub sorts like the API does.
 * @param {Array<{status: number, body: object}>} [options.failures]  Queued responses.
 */
export function stubFetch({ lines = [], messages = [], failures = [] } = {}) {
  const calls = [];
  const queued = [...failures];
  let inbox = [...messages];

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({
      url,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      authorization: init?.headers?.authorization,
    });

    const next = queued.shift();
    if (next) {
      return response(next.status, next.body);
    }

    if (parsed.pathname === "/api/v1/lines") {
      return response(200, { data: lines });
    }

    const match = parsed.pathname.match(/^\/api\/v1\/lines\/([^/]+)\/messages$/);
    if (match) {
      if (decodeURIComponent(match[1]) !== LINE_ID) {
        return response(404, { error: "No line with that id in this key's workspace." });
      }
      const after = parsed.searchParams.get("after");
      const limit = Number(parsed.searchParams.get("limit") ?? 50);
      let data = [...inbox].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      if (after) {
        data = data.filter((entry) => entry.receivedAt > after); // strictly after, like the API
      } else {
        data = data.reverse(); // newest first
      }
      return response(200, { data: data.slice(0, limit) });
    }

    return response(404, { error: "Not found" });
  };

  return {
    fetch: fetchImpl,
    calls,
    /** Simulate a text landing while a wait is in progress. */
    deliver(entry) {
      inbox.push(entry);
    },
    set(entries) {
      inbox = [...entries];
    },
  };
}

function response(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

/**
 * A clock and a sleep that move together, so timeout tests finish instantly.
 */
export function fakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
