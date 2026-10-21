# Local Workshop verification map

These recipes cover the local launcher and the opt-in ChatGPT path. Use the repository's real `pnpm run-local` command and a dedicated `chrome-devtools-axi` session. Preserve Workshop and keyring data.

- [Workshop entry](workshop-entry.md) covers both launch modes, the sign-in page, and the signup link.
- [Providers](providers.md) covers the auth gate, the disconnected ChatGPT panel, and the plain-mode absence of that panel.
- [Broker and lifecycle](broker-lifecycle.md) covers loopback listeners, capability rejection, clean shutdown, and restart.

A screenshot must name its mode and entry point. Save the action, resulting snapshot, screenshot, and console check outside the checkout. Do not count a blocked authenticated route as a verified Providers page. Do not count synthetic broker tests as a successful OpenAI sign-in.
