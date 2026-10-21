import { createHash } from "node:crypto";

/** OS credential store only: no plaintext fallback or credentials in environment variables. */
export async function createCredentialStore() {
  const { Entry } = await import("@napi-rs/keyring");
  const entry = (key) =>
    new Entry("cloudflare-os.chatgpt.local.v1", createHash("sha256").update(key).digest("hex"), {
      linux: { store: "secret-service" },
    });
  return {
    async get(key) {
      const value = entry(key).getPassword();
      return value == null ? undefined : JSON.parse(value);
    },
    async set(key, value) {
      entry(key).setPassword(JSON.stringify(value));
    },
  };
}
