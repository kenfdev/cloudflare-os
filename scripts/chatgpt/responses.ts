// Adapter for the documented ChatGPT-plan subset of Responses. API-key requests never use it.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
const ALLOWED = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "include", "text", "prompt_cache_key",
]);
const NAMESPACE = "workshop";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize pi's Responses request without changing tool IDs, arguments, or history order. */
export function normalizeResponses(body: unknown): Record<string, unknown> {
  if (!record(body) || typeof body.model !== "string" || !body.model || !Array.isArray(body.input)) {
    throw new Error("Invalid ChatGPT Responses request.");
  }
  const output = Object.fromEntries(Object.entries(body).filter(([key]) => ALLOWED.has(key)));
  output.store = false;
  output.stream = true;
  output.input = body.input.map(item => {
    if (!record(item)) throw new Error("Invalid ChatGPT input item.");
    // The preview accepts developer messages, not explicit system messages.
    if (item.role === "system") return { ...item, role: "developer" };
    if ((item.type === "function_call" || item.type === "custom_tool_call") &&
        item.namespace === undefined) return { ...item, namespace: NAMESPACE };
    return item;
  });
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error("Invalid ChatGPT tools.");
    // Workshop tools execute locally. Never smuggle unsupported hosted tools onto this route.
    if (!body.tools.every(tool => record(tool) &&
        (tool.type === "function" || tool.type === "custom"))) {
      throw new Error("ChatGPT supports only local function/custom tools in Workshop.");
    }
    output.tools = body.tools.length ? [{ type: "namespace", name: NAMESPACE,
      description: "Tools executed locally by the Gadgets Workshop.", tools: body.tools }] : [];
  }
  if (record(output.tool_choice)) {
    if (output.tool_choice.type !== "function" && output.tool_choice.type !== "custom") {
      throw new Error("Unsupported ChatGPT tool choice.");
    }
    output.tool_choice = { ...output.tool_choice, namespace: NAMESPACE };
  }
  return output;
}

const failure = (code: string) => `event: response.failed\ndata: ${JSON.stringify({
  type: "response.failed", response: { status: "failed", error: {
    code, message: "ChatGPT did not complete this response. Check your connection and plan limits.",
  } },
})}\n\n`;

/** Send only to the public Responses endpoint and require a successful terminal stream event. */
export async function proxyResponses({ body, accessToken, signal, fetchImpl = fetch }: {
  body: unknown;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(normalizeResponses(body)),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return new Response("ChatGPT inference unavailable. Check connection and plan limits.", {
      status: response.ok ? 502 : response.status,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let terminal = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
          if (pending.length > 8 * 1024 * 1024) throw new Error("Oversized ChatGPT stream event.");
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const event = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = event.split("\n").filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart()).join("\n");
            if (data && data !== "[DONE]") {
              const parsed: unknown = JSON.parse(data);
              if (record(parsed) && parsed.type === "response.completed") terminal = true;
              if (record(parsed) && (parsed.type === "response.failed" ||
                  parsed.type === "response.incomplete" || parsed.type === "error")) {
                terminal = true;
                const details = record(parsed.response) && record(parsed.response.error)
                    ? parsed.response.error : parsed;
                const code = typeof details.code === "string" && /^[a-z_]{1,100}$/.test(details.code)
                    ? details.code : "chatgpt_response_incomplete";
                controller.enqueue(encoder.encode(failure(code)));
                continue;
              }
            }
            controller.enqueue(encoder.encode(`${event}\n\n`));
          }
          if (done) {
            if (!terminal) controller.enqueue(encoder.encode(failure("chatgpt_stream_interrupted")));
            controller.close();
            return;
          }
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        }
      } catch {
        controller.enqueue(encoder.encode(failure("chatgpt_stream_interrupted")));
        controller.close();
        await reader.cancel().catch(() => {});
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-store",
  } });
}
