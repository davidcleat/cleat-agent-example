# Contributing

Bug reports and small, focused pull requests are welcome.

## Getting set up

```bash
npm install
npm test
```

The tests use Node's built-in test runner and a stubbed `fetch`. **They never
touch the network and never need a Cleat API key.** Keep it that way: if a change
needs a new API shape, add it to the stub in `test/`.

Running the example itself costs money (it calls the Claude API) and needs a
real Cleat line, so it is not part of CI. The tests cover the tool layer and the
refusal boundary with a stubbed API.

## House rules

- No API keys, tokens or real phone numbers in code, tests, fixtures or commit
  messages. Line ids in fixtures are made up; phone numbers use the
  555 range.
- No invented numbers in the docs: no latency figures, delivery rates or
  benchmarks we have not measured, and no claim that a particular service will
  accept a Cleat number. Nobody can know that in advance.
- Cleat lines are receive-only. Do not add anything that looks like sending a
  text, placing a call or rotating numbers — the API has no such endpoint.
- Keep the examples about accounts the reader already owns or their company
  owns. That is what the product is for, and the only thing we document.

## Reporting a problem

Open an issue with the version, Node version, what you called and what came
back. Redact keys and the message bodies of real texts.
