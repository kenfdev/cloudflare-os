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
