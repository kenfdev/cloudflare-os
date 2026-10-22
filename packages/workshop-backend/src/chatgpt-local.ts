// This is a closed protocol, not an HTTP proxy. Only the local launcher can install the broker
// capability; a user's model config cannot choose its URL, credentials, or Workshop identity.
const PATHS = new Set(["/status", "/start", "/models", "/logout", "/responses"]);

/** Whether the local launcher installed a well-formed loopback broker capability. */
export function localChatGptAvailable(env: Cloudflare.Env): boolean {
  const broker = env.LOCAL_CHATGPT_BROKER;
  if (!broker || !/^[A-Za-z0-9_-]{43,}$/.test(broker.secret)) return false;
  try {
    const url = new URL(broker.url);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port &&
        url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/** Call a fixed local broker operation under the authenticated Workshop owner's identity. */
export async function chatGptBroker(
    env: Cloudflare.Env, owner: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (!localChatGptAvailable(env)) throw new Error("ChatGPT requires pnpm run-local --chatgpt.");
  if (!owner || !PATHS.has(path)) throw new Error("Invalid local ChatGPT operation.");
  const broker = env.LOCAL_CHATGPT_BROKER!;
  const response = await fetch(new URL(path, broker.url), {
    ...init,
    redirect: "manual",
    headers: {
      "Authorization": `Bearer ${broker.secret}`,
      "X-Workshop-User-Id": owner,
      "Content-Type": "application/json",
    },
  });
  // Inference errors are sanitized by the broker and must remain HTTP responses so the SDK
  // retains their status instead of reporting a transport-level "Connection error".
  // Other operations must never reflect raw OAuth errors into frontend error reporting.
  if (!response.ok && path !== "/responses") {
    await response.body?.cancel();
    throw new Error(`Local ChatGPT request failed (${response.status}). Reconnect or check your plan limits.`);
  }
  return response;
}

