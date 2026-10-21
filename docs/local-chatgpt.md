# Use a ChatGPT subscription locally

This opt-in preview adds **Continue with ChatGPT** to the local Workshop. It does not
turn a deployed Cloudflare Worker into a subscription client. Existing API-key and
AI Gateway model configurations remain available and unchanged.

## Start

Use the repository's supported Node version (Node 24 or later) and pnpm. On macOS,
keep Keychain available; on Windows, use Windows Credential Manager. Linux requires
an unlocked Secret Service keyring and a working D-Bus session. Headless Linux
without Secret Service is not supported; there is deliberately no plaintext fallback.

```sh
pnpm run-local --chatgpt
```

Open http://localhost:8787 and create or sign in to your **Workshop** account.
For a new account, finish the setup screens. You can choose **Next** without adding
a model or connecting services, then choose **Let's build**. Open the profile menu
at the bottom of the sidebar and choose **Providers**. In the local ChatGPT section:

1. Choose **Continue with ChatGPT** and authorize in the OpenAI browser window.
2. Allow ChatGPT plan usage when prompted. Signing in without that permission is
   not enough to run models.
3. Close the callback tab and refresh the connection if necessary.
4. Pick a model from your account's live catalog and add it. Optionally set it as
   your preferred chat model and quick/title model.

ChatGPT sign-in is separate from Workshop sign-in. A connected account belongs to
that Workshop user, not to every user of the local installation. This first version
supports one retained ChatGPT registration per Workshop user, not an account picker.
Signing out clears tokens but retains the registration for reconnecting to the same
account/workspace. Use a different Workshop account for a separate registration.

The normal `pnpm run-local` command does not start this broker or expose sign-in.
`pnpm dev-server --chatgpt` also supports frontend development. Do not reverse-proxy,
share, or expose this development runtime to a network. The launcher forces Wrangler
to listen on 127.0.0.1 and refuses a non-loopback backend host.

## Routing and limits

Explicit ChatGPT models bypass both platform and user AI Gateways. They never fall
back to an API key or paid gateway if disconnected, unavailable, or usage-limited.
For a ChatGPT chat, lightweight title and compaction requests use its ChatGPT model
as well; a separately selected ChatGPT quick model covers other quick tasks. Local
function/custom tools remain executed by Workshop, not hosted OpenAI tools.

Requests use the public `https://api.openai.com/v1/responses` endpoint with streaming
and `store: false`. The adapter removes unsupported preview fields and groups local
tools into a namespace. It treats incomplete, failed, and interrupted streams as
errors, including usage-limit failures after output has started. No Codex executable,
borrowed OAuth client ID, or ChatGPT `backend-api` endpoint is used.

Your ChatGPT account's model availability and plan-sharing limits still apply. Plan
usage may be shared with other apps, and credit usage depends on your ChatGPT account
settings. Review [ChatGPT Usage settings](https://chatgpt.com/settings/usage).

## Credentials and local security

The Node broker owns OAuth, verified identity, refresh, and inference. Access,
refresh, and retained ID tokens live only in the OS credential store. They never go
to browser storage, Worker Durable Objects, `.wrangler` data, or model settings.

Each launch generates a separate short-lived broker capability for the trusted
Worker. It is placed in the gitignored generated `wrangler.dev.jsonc` with owner-only
permissions and removed on ordinary shutdown. Wrangler verbosity is forced to
`error` in this mode so its usual binding listing cannot print that capability.
Do not share local generated configs or verbose diagnostics. The capability is not
an OAuth credential but authorizes local broker operations while that process runs.

The broker accepts only fixed paths, validates its loopback Host, rejects browser
API requests, and requires the launch capability plus a server-derived Workshop
owner identity. Callback states are random, single-use, expiring, and owner-bound.
PKCE, nonce, signature, issuer, audience, and account continuity are validated.
Refresh is serialized, rotating credentials are checkpointed in the keychain, and
logout invalidates in-flight sign-ins and inference.

Disconnect attempts to revoke the renewable session and clears local tokens. If
remote revocation cannot be confirmed, the UI warns you to disconnect the app in
ChatGPT Settings. A process crash can leave a fail-closed lock; see the
[broker maintenance notes](../scripts/chatgpt/README.md) before removing it.

## Local verification and troubleshooting

Use the project skill at `.agents/skills/verify-local-workshop/SKILL.md` to check
both launch modes, browser pages, built JavaScript chunks, broker security, and
shutdown. Its agent-only checks do not sign in to OpenAI or run paid inference.

Keep the server running while creating an account. Signup loads the `hash-wasm`
password-hashing module on demand. If the browser reports a failed dynamic import,
check that http://localhost:8787 is still available, then hard-refresh after a
restart or rebuild. A rebuild replaces the frontend assets, so avoid rebuilding
while another person is using the local instance.

For detached Linux runs, stop the process group created by `setsid`, not only
pnpm's outer wrapper PID. The verification skill records that group and gives the
stop command. A normal stop must remove both the broker lock and the generated
backend capability config before another ChatGPT launch.

## Validation and remaining manual check

Automated tests use fake provider transport and in-memory credential stores, with
synthetic signed JWTs. They do not sign into any account or exercise a real keychain.
Before considering this production-ready, manually verify the above consent flow
on your OS, make a short chat with a local tool call, generate a title, restart and
refresh credentials, and disconnect. This PR has not performed live subscription
inference or authenticated end-to-end testing.

Official protocol references:
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
