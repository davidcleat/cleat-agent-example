# cleat-agent-example

A worked example of an AI agent finishing a sign-in **on an account its owner already holds**, by reading the verification code off the owner's own [Cleat](https://cleat.so) US mobile line.

The owner starts the sign-in. The agent's whole job is the step in the middle: wait for the code that the service texts to the owner's line, and hand it to the sign-in the owner started. It has four tools and no others. It cannot read another line, cannot send the code anywhere else, cannot send a text, and cannot create an account — and those limits are enforced in the code in [`src/tools.js`](src/tools.js), not requested in a prompt.

Cleat rents ID-verified US mobile numbers that receive SMS/2FA codes and transcripts of incoming calls. Receive-only: no outbound texts, no outbound calls, no 911. One identity-verified owner per line. That is the shape of the product, and it is why this example is about the owner's own accounts: there is no supply of extra numbers here, and an agent cannot verify an identity or sign itself up.

## Install

Node 20 or newer. Not on npm; clone it.

```bash
git clone https://github.com/davidcleat/cleat-agent-example.git
cd cleat-agent-example
npm install
```

## Run it

```bash
cp .env.example .env && $EDITOR .env

# Then, with the login open in front of you:
node src/main.js "I'm about to press 'Send code' on my own Shopify login. \
Wait for the text on my line and submit it."
```

A run looks like this:

```
  -> wait_for_code({"lineId":"8f14e45f-…","timeoutSeconds":120})
  <- ok {"found":true,"code":"••••••","body":"•••••• is your code","from":"32665", …}
  -> submit_verification_code({"code":"••••••"})
  <- ok {"submitted":true,"destination":"https://…","status":204,"ok":true}

Submitted the code to the sign-in you started. It came from 32665 at 10:02:41.

Finished after 3 turn(s): end_turn. 2 tool call(s).
```

Codes are hidden in the transcript unless you pass `--show-code`. Running it calls the Claude API, which costs money.

**The order matters.** `wait_for_code` reads where the inbox stands before it waits, and only accepts messages that arrive after that point, so a code from an earlier sign-in is never used. Start the agent, let it call `wait_for_code`, and press "Send code" while it is waiting. If you triggered the text first, the agent will say it cannot tell that code apart from an older one and ask you to send a new one. That is the correct answer, not a bug.

## The boundaries

This is the part worth reading. Each limit exists in a specific place, so you can check it.

| Boundary | Where it lives |
| --- | --- |
| The agent may read exactly one line | `allowedLineId` in [`src/tools.js`](src/tools.js). Any other line id is refused before a request is made. |
| The key itself cannot reach another line | Cleat API key scope. A line outside the key's scope answers `404`. |
| The key stops working on its own | Cleat API key expiry. After it, `401` with code `key_expired`. |
| The agent cannot choose where the code goes | `submit_verification_code` takes `{ code }` and nothing else. The destination is `SIGN_IN_CALLBACK_URL`, set by the owner before the agent ran. With it unset, submitting is refused and the agent reports the code to the owner instead. |
| One code per run | A counter in the submit tool. A second attempt is refused. |
| Nothing that looks like a code is accepted | The submit tool validates the shape and refuses prose, URLs and anything with a newline. |
| The agent cannot send a text or place a call | No tool, and no API: a Cleat line is receive-only. |
| The agent cannot create an account | No tool, and the system prompt says to refuse if asked. Identity verification is done once, by a person, for the account. |
| The run cannot go on forever | `maxTurns`, default 8, in [`src/agent.js`](src/agent.js). |
| A refusal is not a crash | Refusals come back as `tool_result` with `is_error: true`, so the model reads them and corrects itself. |

The system prompt in [`src/agent.js`](src/agent.js) states the same boundaries in words, because a model that understands why it is being stopped behaves better than one that only hits a wall. The words are not the mechanism. The code and the key's scope are.

### What this example is not for

Not for creating accounts, not for signing up in bulk, not for holding a number nobody can trace to a person, and not for getting around a service's limits. Cleat sells one line per subscription to one verified owner, for accounts that owner is entitled to hold; an account used otherwise is closed. If you need a pool of numbers, this is the wrong product and this is the wrong example.

Good uses look like: a company's shared business login whose 2FA lands on the company line; a staging or production account your own test suite signs into; a console you already pay for, where an on-call agent needs the code to get in.

## How it is built

- [`src/tools.js`](src/tools.js) — the four tools, their schemas, and every refusal.
- [`src/agent.js`](src/agent.js) — the tool-calling loop, written out by hand so each turn is visible: append the assistant content unchanged (thinking blocks included), answer every `tool_use` with one `tool_result`, all in a single user message.
- [`src/client.js`](src/client.js) / [`src/watch.js`](src/watch.js) — the two Cleat REST calls, and the arm-then-wait logic that refuses stale codes.
- [`src/main.js`](src/main.js) — the CLI, which redacts codes in the transcript by default.

The only dependency is `@anthropic-ai/sdk`. The model is `claude-opus-5`.

If you would rather give an assistant these tools over MCP than write a loop, Cleat runs a hosted MCP server at `https://cleat.so/api/mcp` — see [Cleat for AI agents](https://cleat.so/for/ai-agents).

## Get an API key

1. Create a Cleat account at [cleat.so](https://cleat.so) and subscribe to a line — $24.99/month or $249.90/year.
2. Verify your identity once, with a government ID. Until the workspace owner has verified, the API answers `403`: the line runs and keeps every text, but nothing can be read. An agent cannot do this step.
3. In **workspace settings → API keys**, create a key. It starts with `clt_` and is shown once.
4. **Scope it to the one line and set an expiry.** That is what makes a key safe to hand to an agent: a line outside the scope answers `404`, and after the expiry the key answers `401` with `key_expired`. Revoking it locks the agent out on its next call and touches nothing else — no password, no session, no other line.

Only the workspace owner can create keys.

## Limits

- **Receive-only.** A Cleat line cannot send a text, place a call, or reach 911.
- **US numbers**, one line per subscription, no area code choice, no pools.
- **One verified owner per line.** Checked once, for the account, by a person.
- **120 requests per minute per key.** `wait_for_code` polls every 2 seconds while waiting; a `429` is ridden out rather than raised.
- **`code` is best effort.** It can be empty while the text is fine, so the agent gets `body` too and is told to say when it is unsure rather than guess.
- **A line is a shared inbox, not a queue.** Two agents on one line are both told about the next code. Give each agent its own line.
- **A line on hold cannot be read.** If a subscription lapses, texts are kept but the API answers `402` until it resumes.
- Cleat cannot tell you that a particular service will accept its numbers. No provider can.

## Tests

```bash
npm test
```

They cover the loop against a scripted stand-in for the Anthropic client and the tools against a stubbed Cleat API: no network, no keys, no tokens spent. The refusals have tests of their own — that is the part of this repo most worth keeping honest.

## Links

- [cleat.so](https://cleat.so)
- [Cleat for AI agents](https://cleat.so/for/ai-agents) — the hosted MCP server
- [Cleat for developers](https://cleat.so/for/developers) — REST API and signed webhooks
- [OpenAPI 3.1 description](https://cleat.so/openapi.json)

MIT licensed.
