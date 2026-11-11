# omniroute

A small local gateway that keeps AI requests working when one provider hits a
usage limit. It exposes one OpenAI-compatible endpoint. Each request goes to the
first healthy provider on your list; if that provider is rate limited, out of
quota, rejects the key, or is failing, it is put on cooldown and the next one is
tried. When the cooldown ends, the preferred provider is used again.

No npm dependencies. Node 22.18+.

## Setup

```sh
cd omniroute
cp omniroute.config.example.json omniroute.config.json   # order = priority
cp .env.example .env                                     # your provider keys
npm start
```

Fill in `model` for every target that says `REPLACE_ME`, and check each
provider's docs for its current OpenAI-compatible base URL and model names.
Targets with a missing key or an unset model are skipped with a warning, so the
example file is safe to start with. A local server such as Ollama needs no key:
leave out `apiKeyEnv`.

Point any OpenAI-compatible tool at it:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:8789/v1
export OPENAI_API_KEY=anything          # or your OMNIROUTE_TOKEN, if you set one
# model name: "omni" (the gateway replaces it with each target's own model)
```

## What counts as a failure

| Upstream answer | What happens |
| --- | --- |
| 429 with `Retry-After` | Cool down for that long (1 s to 24 h) and try the next |
| 429 or 402 mentioning quota or billing | Cool down `quotaCooldownSeconds` (1 h) |
| Other 429 | Cool down `cooldownSeconds` (60 s) |
| 401, 403 | Key rejected: cool down `authCooldownSeconds` (1 h) |
| 5xx, 404, timeout, connection error | Cool down `errorCooldownSeconds` (15 s) |
| 400, 413, 422 | Your request is invalid: returned as is, no failover |

If every target fails the answer is 502, listing each attempt. If all are
cooling down it is 503 with `Retry-After`.

Every answer carries `x-omniroute-target` (who served it) and, after a
failover, `x-omniroute-failed`.

## Other endpoints

- `GET /status`: per target state, cooldown seconds left, success and failure counts, last failure.
- `POST /reset`: clear all cooldowns, if the gateway guessed a limit wrong.
- `GET /v1/models`, `GET /health`.

All of them except `/health` need the bearer token when `OMNIROUTE_TOKEN` is set.

## Security

- It binds to `127.0.0.1`. Any other `host` requires `OMNIROUTE_TOKEN`, because
  the gateway spends your provider keys for whoever can reach it.
- Keys are read from environment variables only. They are never logged, never in
  `/status`, and never sent to a client.
- Plain `http` is only accepted for localhost targets.
- Logs hold the target, status and timing, never prompts.
- Your prompts go to whichever provider answers. Check that each one is
  acceptable for what you send.

## Limits

- **OpenAI chat format only.** Tools that speak Anthropic's own API cannot use
  it, and that includes Claude Code. A subscription login cannot be redirected
  either. Anthropic's OpenAI-compatible layer works as a target but has fewer
  features than its native API.
- **Streaming can only fail over before the first byte.** If a stream breaks
  halfway, the connection is dropped; it cannot continue on another provider.
- **Models differ.** A fallback model may answer worse, ignore some parameters,
  or have a smaller context window (that comes back as a 400).
- **Not tried against real providers.** It is tested against fake ones. Run one
  real request through each target before relying on it.

## Tests

```sh
npm test
npm run typecheck
```
