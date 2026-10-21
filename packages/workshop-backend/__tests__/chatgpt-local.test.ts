import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getModel } from "../src/ai-models";
import { localChatGptAvailable } from "../src/chatgpt-local";
import { serializeAdminConfig } from "../src/admin-config";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage";
import type { UserDurableObject } from "../src/user";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_USER: DurableObjectNamespace<UserDurableObject>; }
}
const broker = { url: "http://127.0.0.1:43210", secret: "s".repeat(43) };
const config: AiModelConfig = { provider: "openai", model: "gpt-5.4", apiToken: "",
  authentication: "chatgpt", chatgptOwner: "server-owner" };
const profile = { type: "agent" as const, id: "chatgpt:gpt-5.4", name: "ChatGPT" };
const gateway = {
  LOCAL_CHATGPT_BROKER: broker, CF_AI_GATEWAY: "paid", CF_AI_GATEWAY_ACCOUNT_ID: "paid",
  CF_AI_GATEWAY_API_TOKEN: "paid-secret", CF_AI_GATEWAY_PROVIDERS: "openai",
} as Cloudflare.Env;
afterEach(() => vi.unstubAllGlobals());

describe("local ChatGPT routing", () => {
  it("only accepts an explicit loopback launcher capability", () => {
    expect(localChatGptAvailable({} as Cloudflare.Env)).toBe(false);
    expect(localChatGptAvailable(gateway)).toBe(true);
    for (const url of ["http://localhost:1", "https://127.0.0.1:2", "http://example.com:1", "http://127.0.0.1:1/proxy", "http://user:pass@127.0.0.1:1"]) {
      expect(localChatGptAvailable({ LOCAL_CHATGPT_BROKER: { ...broker, url } } as Cloudflare.Env)).toBe(false);
    }
  });
  it("bypasses both gateways, pins transport/owner and cannot fall back to an API key", async () => {
    const captured: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new Request(input, init));
      return new Response("unavailable", { status: 503 });
    });
    const handle = getModel(gateway, config, { type: "user", id: "different-initiator", name: "User" },
      { userGateway: { accountId: "other-paid", apiKey: "other-paid-secret" } });
    expect(handle.aiGatewayLogRoute).toBeUndefined();
    const unwantedTransport = vi.fn();
    const result = await handle.stream(handle.model, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
      { fetch: unwantedTransport, thinking: false }).result();
    expect(result.stopReason).toBe("error");
    expect(unwantedTransport).not.toHaveBeenCalled();
    expect(captured.length, result.errorMessage).toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.url).toBe(`${broker.url}/responses`);
      expect(request.headers.get("authorization")).toBe(`Bearer ${broker.secret}`);
      expect(request.headers.get("x-workshop-user-id")).toBe("server-owner");
      expect(request.headers.has("cf-aig-authorization")).toBe(false);
    }
  });
  it("does not use a paid provider when the local launcher is absent", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const handle = getModel({ ...gateway, LOCAL_CHATGPT_BROKER: undefined }, config,
      { type: "user", id: "u", name: "User" });
    const result = await handle.stream(handle.model, { messages: [] }).result();
    expect(result.stopReason).toBe("error"); expect(fetcher).not.toHaveBeenCalled();
  });
});

it("server rebinds config owner, hides it, and keeps quick tasks on the subscription", async () => {
  const stub = env.TEST_USER.getByName(`chatgpt-security-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async user => {
    const impl = user as unknown as { env: Cloudflare.Env };
    const original = impl.env;
    impl.env = { ...original, ...gateway, BLUEPRINTS: {
      get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, userModelsEnabled: false }),
    } as unknown as KVNamespace };
    try {
      await user.addModel(profile, config);
      const context = await user.getChatContext(profile.id);
      expect(context.aiModel!.config.chatgptOwner).not.toBe(config.chatgptOwner);
      expect(context.aiModel!.config.chatgptOwner).toBe(stub.id.toString());
      expect(context.quickModel).toEqual(context.aiModel!.config);
      expect((await user.getModelConfig(profile.id)).config).not.toHaveProperty("chatgptOwner");
      expect((await user.listModels()).map(p => p.id)).toContain(profile.id);
      await expect(user.updateModel(profile, { ...config, authentication: undefined })).rejects.toThrow();
      await expect(user.addModel({ ...profile, id: "other" }, { ...config, apiUrl: "http://attacker" })).rejects.toThrow("endpoint");
      await expect(user.addModel({ ...profile, id: "other" }, { ...config, extraHeaders: { Authorization: "bad" } })).rejects.toThrow("endpoint");
    } finally { impl.env = original; }
  });
});
