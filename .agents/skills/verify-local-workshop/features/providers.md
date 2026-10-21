# Providers

A signed-in Workshop user can manage model providers. ChatGPT mode adds the local subscription panel; plain mode does not.

## Sub-features

- `providers-auth-gate` shows sign-in to an unauthenticated visitor.
- `providers-chatgpt-disconnected` shows the local ChatGPT panel and **Continue with ChatGPT** before connection.
- `providers-plain` omits local ChatGPT sign-in while preserving normal provider controls.
- `providers-live` covers consent, model discovery, and connected model selection, performed only by the user.

## How to get to it (user POV)

Open **Open profile menu** at the bottom of the sidebar, then choose **Providers**, or visit `http://localhost:8787/providers` directly.

## Driving it with chrome-devtools-axi

Preconditions: Doctor passes. Authenticated checks require a Workshop session supplied or explicitly authorized by the user. Stop at sign-in if the task reserves account creation for the user.

- Run `chrome-devtools-axi open http://localhost:8787/providers` in an unauthenticated profile. Capture the **Sign in to your account** gate. Record this as `providers-auth-gate`, not as a loaded Providers panel.
- With an allowed signed-in session, open **Open profile menu**, take its current snapshot, and click **Providers**. Repeat the direct `/providers` URL. Require the **AI providers** heading and **ChatGPT connection** region with **Not connected to ChatGPT** and **Continue with ChatGPT** in ChatGPT mode. Capture the page and console output without exposing account secrets.
- Click **Refresh connection** while disconnected. Require **Not connected to ChatGPT** to remain without an error. Do not click **Continue with ChatGPT**.
- Repeat both entry points in plain mode. Require normal provider controls and no **Continue with ChatGPT** action.
- Leave OpenAI consent and all connected checks to the user. The manual path is documented in `docs/local-chatgpt.md`.

## Gotchas

- Complete the optional onboarding screens first, without adding a model or connecting services. New accounts see Setup even at `/providers` until they finish.
- An unauthenticated session cannot prove either authenticated panel. Report the missing precondition and do not inject RPC state or bypass authentication.
- Clicking **Continue with ChatGPT** starts external OAuth registration. It is outside agent-only local verification.
- No live account means model listing, inference, tools, titles, refresh, and disconnect/revocation are unverified, even when fake-provider tests pass.
