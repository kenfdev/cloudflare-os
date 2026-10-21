# Local ChatGPT broker

`startBroker({ secret, port? })` returns `{ url, close() }`. Generate a fresh random
32-byte secret for each launch and pass it only to the trusted local Workshop
Worker. Never put it in a browser environment, URL, log, generated checked-in
configuration, or production deployment. The server binds only to `127.0.0.1`.

All API requests require `Authorization: Bearer <launch secret>` and
`X-Workshop-User-Id: <authenticated Workshop user ID>`. The Worker must derive the
user ID from its authenticated session, never from a browser-supplied header.
Requests with browser Origin/Fetch-Metadata headers or an unexpected Host fail.

- `POST /start` returns `{ authorizationUrl }`; open it only after the user's sign-in action.
- `GET /status` returns credential-free connection state, sharing permission and identity.
- `GET /models` returns `{ models: [{ slug, displayName }] }` from that account's live catalog.
- `POST /responses` forwards the normalized request to the fixed public Responses endpoint.
- `POST /logout` aborts in-flight requests, attempts remote session revocation, clears local
  tokens and returns `{ connected: false, revoked, warning? }`. Show any revocation warning.
- `GET /auth/callback` is the sole browser endpoint. It requires an unexpired, single-use
  OAuth state bound to the initiating Workshop user. It is not a general API exception.

Credentials and host IDs use the OS keychain (`@napi-rs/keyring`). Linux requires
Secret Service; there is no plaintext fallback. ID tokens are validated using
`jose` and OpenAI's discovered JWKS before storing identity or permitting inference.
This initial integration maintains one saved ChatGPT registration per Workshop
user. Logout retains that registration and the host ID for subsequent sign-in.

A per-OS-user exclusive temporary lock prevents two brokers from racing rotating
refresh tokens. A crash intentionally leaves a stale lock: first verify that no
Cloudflare OS ChatGPT broker is running, then remove the empty
`cloudflare-os-chatgpt-<OS user ID>.lock` directory in the system temp directory.
Do not remove a live broker's lock. Normal shutdown removes it automatically.

Refreshes are serialized per user. Received rotations are checkpointed in the
keychain before checking a new ID token, so a JWKS outage cannot lose a consumed
refresh grant. A generation guard prevents logout or replacement sign-in from
restoring an old in-flight session. Provider redirects are rejected.

Run the isolated tests with `node --test scripts/chatgpt/*.test.*`. Tests inject
in-memory stores and fake provider transport, use synthetic signing keys, and do
not authenticate, create credentials, or contact OpenAI.

Implementation references (not vendored DevKit code):
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
