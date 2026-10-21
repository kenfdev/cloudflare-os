---
name: verify-local-workshop
description: Verify the local Cloudflare OS Workshop in a real browser, including pnpm run-local with and without --chatgpt, Providers, loopback-only broker access, capability rejection, and clean shutdown. Use after local-launcher or ChatGPT integration changes and before handing over a running local instance.
---

# Verify local Workshop

Read [the feature map](features/README.md). Run from the repository root on Linux with Node 24+, the pinned pnpm, `ss`, and `chrome-devtools-axi`.

## Safety and isolation

- Inspect `scripts/run-local.ts`, `scripts/run-dev-server.ts`, generated-config sources, and build hooks before launching. Local emulation is allowed; remote bindings, Cloudflare login/deployment, and paid gateway calls are not part of this check.
- Check environment variable **names**, not secret values, for `CF_AI_GATEWAY*`, `CLOUDFLARE_*`, and `WRANGLER_*`. Inspect local `.dev.vars`/`.env` configuration without printing secrets. Stop if the target is remote or unclear.
- The broker is exclusive per OS user. Do not run two brokers, two launchers in one checkout, or drive someone else's instance. Check `ss -ltnp 'sport = :8787'` before starting. Never kill by process name.
- `run-local` persists Workshop data in `.wrangler`. Preserve it. A fresh checkout starts at Workshop sign-in, not at an authenticated page. Do not delete databases to reset verification.
- Do not create an account unless the task explicitly permits it. Never enter OpenAI credentials, inspect saved tokens, click **Continue with ChatGPT**, or call broker `/start` during agent-only checks. Those steps require the user's own browser action.
- Never print the backend's generated config. It contains a live broker capability. Never enable verbose Wrangler logging in ChatGPT mode. Keep evidence outside the checkout, and keep screenshots free of credentials.

## Launch

```sh
node --version
pnpm --version
pnpm install
export PROOF=$(mktemp -d /tmp/workshop-verification.XXXXXX)
umask 077
setsid env WRANGLER_SEND_METRICS=false pnpm run-local --chatgpt > "$PROOF/chatgpt.log" 2>&1 < /dev/null &
CHATGPT_PGID=$!
printf '%s\n' "$CHATGPT_PGID" > "$PROOF/chatgpt.pgid"
```

On Linux, first confirm that the user's Secret Service collection is unlocked through D-Bus metadata. For gnome-keyring:

```sh
busctl --user get-property org.freedesktop.secrets /org/freedesktop/secrets/collection/login org.freedesktop.Secret.Collection Locked
```

Require `b false`. Other Secret Service implementations may use a different collection path. If unavailable or locked, ask the user to unlock their encrypted keyring in their own session. Do not supply an empty password or add a plaintext fallback. A detached launcher must inherit the same `DBUS_SESSION_BUS_ADDRESS`; the daemon must remain running.

Poll `curl --noproxy '*' --max-time 5 -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/` until it returns 200. Use a bounded deadline, such as five minutes, and inspect the launch log on failure. HTTP 200 alone is not readiness: run Doctor and confirm the real browser renders **Cloudflare OS** and **Sign in to your account**, or the authenticated Workshop if a user has supplied that session.

After completing ChatGPT checks, run Cleanup, then repeat with plain mode:

```sh
setsid env WRANGLER_SEND_METRICS=false pnpm run-local > "$PROOF/plain.log" 2>&1 < /dev/null &
PLAIN_PGID=$!
printf '%s\n' "$PLAIN_PGID" > "$PROOF/plain.pgid"
```

## Doctor

Use the bundled executable helper from the repository root:

```sh
node .agents/skills/verify-local-workshop/scripts/doctor.mjs chatgpt "$PROOF/chatgpt.log" | tee "$PROOF/chatgpt-doctor.txt"
node .agents/skills/verify-local-workshop/scripts/doctor.mjs plain | tee "$PROOF/plain-doctor.txt"
```

Run only the command matching the current instance. Enable shell `pipefail` when recording exit status through `tee`.

The helper checks HTML, every built JavaScript chunk's bytes and MIME type, actual loopback listeners, owner-only config permissions, and the absence of the current capability from the selected log. In ChatGPT mode it makes read-only/local rejection probes using a random unregistered owner. It never accesses an existing user's token, starts OAuth, or calls inference for a connected account. It verifies missing/wrong capabilities, missing owner, browser headers, foreign Host, unknown paths, invalid callback state, and disconnected model/inference failures. HTTP probes use `node:http` because Node fetch replaces a custom Host header.

Also inspect process ownership with `ps -eo pid,ppid,pgid,stat,comm` and match the recorded process group. Do not trust a stale PID file. If Doctor fails, resolve that failure before browser actions.

## Drive

Use a dedicated browser session and profile, not a user's existing tabs:

```sh
export CHROME_DEVTOOLS_AXI_SESSION=local-workshop-verification
export CHROME_DEVTOOLS_AXI_USER_DATA_DIR="$PROOF/browser-profile"
chrome-devtools-axi open http://localhost:8787/
chrome-devtools-axi snapshot
chrome-devtools-axi screenshot "$PROOF/workshop.png"
chrome-devtools-axi open http://localhost:8787/providers
chrome-devtools-axi snapshot
chrome-devtools-axi screenshot "$PROOF/providers.png"
chrome-devtools-axi console
```

If Chrome is not installed in a standard location, set `CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` to an installed Chrome/Chromium binary before starting this named session. Stop only this session before changing its launch configuration. Do not disable browser sandboxing to make it start.

Use fresh snapshot UIDs for `click @UID`; another snapshot also advances their generation. Do not copy UIDs between snapshots or page loads. Follow the exact paths in the feature map. When a task authorizes reproducing account creation, use the synthetic signup recipe in [Workshop entry](features/workshop-entry.md) to execute the lazy password-hashing module without logging the generated password. An unauthenticated `/providers` showing sign-in proves the auth gate, **not** that Providers loads. Record authenticated Providers as blocked until the user supplies an allowed session. Never bypass the gate with internal state injection.

## Evidence

Keep logs, Doctor output, before/after screenshots, snapshots, console results, and shutdown checks in `$PROOF`. Record the commit, launch command, process group, and mode. A passing unit suite is supporting evidence, not a substitute for launch and browser proof:

```sh
node --test scripts/chatgpt/*.test.* > "$PROOF/broker-tests.txt" 2>&1
```

State exactly which feature-map paths passed and which were blocked. No real ChatGPT account means OAuth consent, live model catalog, inference/tools, titles, refresh/restart, and revocation remain unverified. Do not describe those as passing based on synthetic tests.

## Cleanup

For a process group created by the commands above, signal the **group**, not only pnpm's wrapper PID:

```sh
kill -TERM -- -"$CHATGPT_PGID"
# For the separate plain-mode run, use its own recorded group instead:
# kill -TERM -- -"$PLAIN_PGID"
```

Wait up to 20 seconds. Require no remaining processes in the owned group, no listener on 8787 or the broker port Doctor reported, and, after ChatGPT mode, no backend capability config or broker lock:

```sh
ss -ltnp 'sport = :8787'
test ! -e packages/workshop-backend/wrangler.dev.jsonc
test ! -d "/tmp/cloudflare-os-chatgpt-$(id -u).lock"
```

Plain mode leaves a non-secret generated config, so the config-removal check applies only to ChatGPT mode. Repeat a ChatGPT launch after shutdown to prove the lock does not block restart. If a crash leaves a lock, follow `scripts/chatgpt/README.md`: first prove no broker is running. Never remove a live lock or any persistent Workshop/keyring data.

Stop the verification browser with `chrome-devtools-axi stop` in its named session. Confirm screenshots and logs still exist. If the task asks to leave the app running, start a fresh detached ChatGPT run after these cleanup checks and report its actual process group, URL, log, and exact group stop command. Keep the keyring daemon running. Use `/maintain-verification-skill` when launch commands or feature paths change.
