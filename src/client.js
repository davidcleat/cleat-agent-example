/**
 * Minimal client for the two Cleat REST endpoints this example needs.
 *
 * The Cleat API is read-only: it lists lines and the messages they received.
 * A Cleat line cannot send a text or place a call, so there is nothing to write.
 */

export const DEFAULT_BASE_URL = "https://cleat.so";

export class CleatError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message, { cause });
    this.name = "CleatError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.apiKey   A key from workspace settings, starting with `clt_`.
 * @param {string} [options.baseUrl]
 * @param {typeof globalThis.fetch} [options.fetch]  Injected in tests.
 */
export function createClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl } = {}) {
  if (!apiKey) {
    throw new CleatError(
      "No Cleat API key. Create one in workspace settings (it starts with clt_) and pass it as CLEAT_API_KEY.",
    );
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new CleatError("No fetch implementation available. Node 20 or newer is required.");
  }

  async function request(path, params) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await doFetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      });
    } catch (cause) {
      throw new CleatError(`Could not reach ${new URL(baseUrl).host}: ${cause.message}`, { cause });
    }

    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }

    if (!response.ok) {
      throw new CleatError(body.error ?? `Cleat API returned ${response.status}.`, {
        status: response.status,
        code: body.code,
      });
    }
    return body;
  }

  return {
    baseUrl,

    /** GET /api/v1/lines -> Line[] (newest first). */
    async listLines() {
      const body = await request("/api/v1/lines");
      return body.data ?? [];
    },

    /**
     * GET /api/v1/lines/{lineId}/messages -> Message[]
     * With `after`, results come back oldest first. Without it, newest first.
     */
    async listMessages(lineId, { after, before, limit } = {}) {
      const body = await request(
        `/api/v1/lines/${encodeURIComponent(lineId)}/messages`,
        { after, before, limit },
      );
      return body.data ?? [];
    },
  };
}
