# Broker and lifecycle

The local ChatGPT broker accepts only authorized server requests on loopback and releases its launch resources on normal shutdown.

## Sub-features

- `broker-loopback` keeps Workshop and the broker on 127.0.0.1.
- `broker-capability` rejects missing capabilities, owners, browser headers, foreign Host, and invalid callbacks.
- `broker-disconnected` refuses models and inference for an unregistered owner without using another provider.
- `shutdown-chatgpt` removes the capability config and broker lock, allowing a new launch.
- `shutdown-plain` stops the ordinary Workshop without creating a broker.

## How to get to it (user POV)

Start `pnpm run-local --chatgpt`, open Workshop, then stop it with Ctrl-C. A detached run uses the recorded process group's SIGTERM command in the main skill. Plain `pnpm run-local` must remain usable without ChatGPT setup.

## Driving it with the shell

Preconditions: this run owns the process group and ports. No real account credentials are inspected.

- Run `node .agents/skills/verify-local-workshop/scripts/doctor.mjs chatgpt "$PROOF/chatgpt.log"`. Require every probe to pass. The helper only reads a newly generated, unregistered owner and sends no OpenAI request.
- Record the broker port reported by Doctor. Stop the owned group with `kill -TERM -- -"$CHATGPT_PGID"`. Require no owned process or listener after 20 seconds, no backend `wrangler.dev.jsonc`, and no `/tmp/cloudflare-os-chatgpt-<uid>.lock`.
- Launch ChatGPT mode again and rerun Doctor. A successful first launch does not prove restart works.
- In plain mode run `node .agents/skills/verify-local-workshop/scripts/doctor.mjs plain`, then stop its own group and check its processes and port.

## Gotchas

- Signalling only pnpm's outer wrapper may leave the server tree running. Record and stop the session's process group.
- Node fetch replaces a caller-supplied Host header. Use the helper's `node:http` probes rather than mistaking that behavior for a broker security failure.
- Never dump the generated backend config or enable verbose Wrangler logs. The helper compares the capability with the log in memory and prints only pass/fail.
- A crash lock is intentionally fail-closed. Do not erase it until no broker process remains, and do not erase keyring or Workshop data.
