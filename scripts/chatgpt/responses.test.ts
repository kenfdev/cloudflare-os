import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeResponses, proxyResponses } from "./responses.ts";

test("subscription requests strip unsupported fields, group tools and preserve history", () => {
  const call = { type: "function_call", call_id: "call_1", name: "readFile", arguments: '{"path":"a"}' };
  const result = { type: "function_call_output", call_id: "call_1", output: "hello" };
  const payload = normalizeResponses({model:"account-model", input:[{role:"system",content:"rules"},call,result],
    tools:[{type:"function",name:"readFile",parameters:{type:"object"}}], max_output_tokens:5,
    temperature:1, metadata:{secret:"must not forward"}, previous_response_id:"old",store:true,stream:false});
  assert.equal(payload.store, false); assert.equal(payload.stream, true);
  assert.equal(payload.max_output_tokens, undefined); assert.equal(payload.temperature, undefined);
  assert.equal(payload.metadata, undefined); assert.equal(payload.previous_response_id, undefined);
  assert.deepEqual(payload.input,[{role:"developer",content:"rules"},{...call,namespace:"workshop"},result]);
  assert.deepEqual(payload.tools,[{type:"namespace",name:"workshop",description:"Tools executed locally by the Gadgets Workshop.",tools:[{type:"function",name:"readFile",parameters:{type:"object"}}]}]);
});

test("hosted tools and malformed input are refused", () => {
  for (const tools of [[{type:"tool_search"}],[{type:"mcp"}],"invalid"]) {
    assert.throws(() => normalizeResponses({model:"m",input:[],tools}));
  }
  assert.throws(() => normalizeResponses({model:"m",input:"text"}));
});

test("cache breakpoints are stripped only at message and content boundaries", () => {
  const marker = { mode: "explicit" };
  const text = '{"prompt_cache_breakpoint":"user data"}';
  const input = [
    ...["system", "developer", "user", "assistant"].map(role => ({
      type: "message", role, prompt_cache_breakpoint: marker,
      content: [{ type: "input_text", text, prompt_cache_breakpoint: marker },
        { type: "input_image", image_url: "data:image/png;base64,test", prompt_cache_breakpoint: marker }],
    })),
    { type: "function_call", call_id: "one", name: "lookup", arguments: text },
    { type: "function_call_output", call_id: "one", output: text },
    { type: "custom_tool_call", call_id: "two", name: "custom", input: text },
    { type: "custom_tool_call_output", call_id: "two", output: text },
    { type: "reasoning", id: "r", summary: [] },
  ];
  const tools = [{ type: "function", name: "lookup", parameters: {
    type: "object", properties: { prompt_cache_breakpoint: { type: "string" } },
  } }];
  const original = structuredClone({ input, tools });
  const normalized = normalizeResponses({ model: "gpt-6.1-sol", input, tools,
    prompt_cache_breakpoint: marker, prompt_cache_mode: "explicit" });
  assert.deepEqual(normalized.input, input.map(item => {
    if ("role" in item) return { type: "message", role: item.role === "system" ? "developer" : item.role,
      content: [{ type: "input_text", text }, { type: "input_image", image_url: "data:image/png;base64,test" }] };
    if (item.type === "function_call" || item.type === "custom_tool_call") return { ...item, namespace: "workshop" };
    return item;
  }));
  assert.equal(normalized.prompt_cache_breakpoint, undefined);
  assert.equal(normalized.prompt_cache_mode, undefined);
  assert.deepEqual((normalized.tools as { tools: unknown[] }[])[0].tools, tools);
  assert.deepEqual({ input, tools }, original);
});

for (const status of [400, 401, 403, 429, 503]) {
  test(`HTTP ${status} retains safe diagnostics without upstream messages or secrets`, async () => {
    const response = await proxyResponses({ body: { model: "m", input: [] }, accessToken: "private-token",
      fetchImpl: async () => Response.json({ error: {
        code: "invalid_parameter", param: "input[0].content[0].prompt_cache_breakpoint",
        message: "private-token private-prompt", authorization: "private-token",
      } }, { status, headers: { "x-request-id": "req_safe-123", "set-cookie": "private-cookie" } }) });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-request-id"), "req_safe-123");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.error.code, "invalid_parameter");
    assert.equal(body.error.param, "input[0].content[0].prompt_cache_breakpoint");
    assert.equal(body.error.request_id, "req_safe-123");
    assert.match(body.error.message, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(JSON.stringify(body), /private-/);
  });
}

test("invalid or non-JSON diagnostic fields are replaced, not reflected", async () => {
  for (const body of ["<html>private-body</html>", JSON.stringify({ error: {
    code: "Bearer private-token", param: "private prompt text", message: "private-body",
  } })]) {
    const response = await proxyResponses({ body: { model: "m", input: [] }, accessToken: "fake",
      fetchImpl: async () => new Response(body, { status: 400, headers: { "x-request-id": "private secret" } }) });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-request-id"), null);
    const error = (await response.json()).error;
    assert.equal(error.code, "chatgpt_inference_failed");
    assert.equal(error.param, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private/);
  }
});

test("oversized error bodies are cancelled and successful empty bodies become HTTP 502", async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const response = await proxyResponses({ body: { model: "m", input: [] }, accessToken: "fake",
    fetchImpl: async () => new Response(oversized, { status: 503 }) });
  assert.equal(response.status, 503);
  assert.equal(cancelled, true);
  assert.equal((await response.json()).error.code, "chatgpt_inference_failed");
  for (const status of [204, 304]) {
    const empty = await proxyResponses({ body: { model: "m", input: [] }, accessToken: "fake",
      fetchImpl: async () => new Response(null, { status }) });
    assert.equal(empty.status, 502);
  }
});

async function stream(events: unknown[]) {
  let captured: Request | undefined;
  const response = await proxyResponses({body:{model:"m",input:[]},accessToken:"test-oauth-token",
    fetchImpl: async (input, init) => {
      captured = new Request(input, init);
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    }});
  assert.equal(captured!.url,"https://api.openai.com/v1/responses");
  assert.equal(captured!.redirect,"error");
  assert.equal(captured!.headers.get("authorization"),"Bearer test-oauth-token");
  return response.text();
}

test("completed is required, not EOF or incomplete", async () => {
  assert.match(await stream([{type:"response.output_text.delta",delta:"hi"}]),/chatgpt_stream_interrupted/);
  const incomplete = await stream([{type:"response.incomplete",response:{status:"incomplete",incomplete_details:{reason:"max_output_tokens"}}}]);
  assert.match(incomplete,/response.failed/); assert.doesNotMatch(incomplete,/"type":"response\.incomplete"/);
  const completed = await stream([{type:"response.completed",response:{status:"completed",output:[]}}]);
  assert.match(completed,/response.completed/); assert.doesNotMatch(completed,/response.failed/);
});

test("usage limits after stream start retain safe code, not upstream body", async () => {
  const result = await stream([{type:"response.failed",response:{status:"failed",error:{code:"subscription_sharing_usage_limit_exceeded",message:"unsafe upstream details"}}}]);
  assert.match(result,/subscription_sharing_usage_limit_exceeded/);
  assert.doesNotMatch(result,/unsafe upstream details/);
});


test("SSE CRLF delimiters may be split at every byte", async () => {
  const text = 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const response = await proxyResponses({body:{model:"m",input:[]},accessToken:"fake",
    fetchImpl:async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }))});
  const output = await response.text();
  assert.match(output,/response.completed/); assert.doesNotMatch(output,/response.failed/);
});

