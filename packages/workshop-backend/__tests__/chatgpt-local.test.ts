import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getModel } from "../src/ai-models";
import { chatGptBroker, localChatGptAvailable } from "../src/chatgpt-local";
import { Type, type Context } from "@earendil-works/pi-ai";
import { proxyResponses } from "../../../scripts/chatgpt/responses";
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
  it("disables subscription cache breakpoints through the real handle, rewrite and adapter", async () => {
    const subscriptionBodies: Record<string, unknown>[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${broker.url}/responses`);
      const body = await request.json();
      subscriptionBodies.push(body);
      return proxyResponses({ body, accessToken: "fake-token", fetchImpl: async (_input, options) => {
        upstreamBodies.push(JSON.parse(String(options?.body)));
        return Response.json({ error: {
          code: "invalid_parameter", param: "prompt_cache_breakpoint", message: "private-prompt fake-token",
        } }, { status: 400, headers: { "x-request-id": "req_regression" } });
      } });
    });
    const context: Context = { messages: [
      { role: "system", content: "Shared instructions.", sections: { environment: "Workspace details." },
        toolsAdded: [{ name: "lookup", description: "Look up a value.",
          parameters: Type.Object({ prompt_cache_breakpoint: Type.String() }) }], timestamp: 0 },
      { role: "user", content: "hello", timestamp: 0 },
    ] };
    const handle = getModel(gateway, { ...config, model: "gpt-6.1-sol" },
      { type: "user", id: "initiator", name: "User" });
    expect(handle.model.compat).toMatchObject({ supportsExplicitPromptCacheMode: false });
    const result = await handle.stream(handle.model, context, { maxRetries: 0 }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/400/);
    expect(result.errorMessage).toMatch(/invalid_parameter/);
    expect(result.errorMessage).toMatch(/prompt_cache_breakpoint/);
    expect(result.errorMessage).toMatch(/req_regression/);
    expect(result.errorMessage).not.toMatch(/Connection error|private-prompt|fake-token/);
    expect(subscriptionBodies).toHaveLength(1);
    expect(upstreamBodies).toHaveLength(1);
    for (const body of [subscriptionBodies[0], upstreamBodies[0]]) {
      expect(body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "developer", content: "Shared instructions.\n\nWorkspace details." }),
      ]));
      expect(JSON.stringify(body.input)).not.toContain("prompt_cache_breakpoint");
    }
    expect(upstreamBodies[0].tools).toEqual([expect.objectContaining({
      type: "namespace", tools: [expect.objectContaining({ name: "lookup", parameters: expect.objectContaining({
        properties: { prompt_cache_breakpoint: { type: "string" } },
      }) })],
    })]);

    // The same catalog model on the API-key route must retain the existing cache rewrite.
    const paid = getModel({} as Cloudflare.Env, { provider: "openai", model: "gpt-6.1-sol", apiToken: "fake-key" },
      { type: "user", id: "initiator", name: "User" });
    expect(paid.model.compat).toMatchObject({ supportsExplicitPromptCacheMode: true });
    let paidBody: Record<string, unknown> | undefined;
    await paid.stream(paid.model, context, { maxRetries: 0, fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.get("authorization")).toBe("Bearer fake-key");
      paidBody = await request.json();
      return Response.json({ error: { message: "stubbed" } }, { status: 400 });
    } }).result();
    expect(paidBody?.input).toEqual(expect.arrayContaining([expect.objectContaining({ content: [
      { type: "input_text", text: "Shared instructions.", prompt_cache_breakpoint: { mode: "explicit" } },
      { type: "input_text", text: "\n\nWorkspace details." },
    ] })]));
  });

  it.each([400, 401, 403, 429, 503])("preserves HTTP %i only for inference, not management calls", async status => {
    vi.stubGlobal("fetch", async () => Response.json({ error: { code: "safe_error" } }, { status }));
    const response = await chatGptBroker(gateway, "server-owner", "/responses", { method: "POST" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: "safe_error" } });
    await expect(chatGptBroker(gateway, "server-owner", "/status")).rejects.toThrow(`(${status})`);
  });

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

