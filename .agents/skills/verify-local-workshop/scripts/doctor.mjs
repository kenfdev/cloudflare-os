#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";

const [mode, logPath] = process.argv.slice(2);
assert(["plain", "chatgpt"].includes(mode), "Usage: doctor.mjs plain|chatgpt [launch-log]");
const configPath = resolve("packages/workshop-backend/wrangler.dev.jsonc");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const broker = config.vars?.LOCAL_CHATGPT_BROKER;
const ports = [8787];
const page = await fetch("http://127.0.0.1:8787/", { signal: AbortSignal.timeout(10000) });
assert.equal(page.status, 200, "Workshop HTTP status");
assert.match(await page.text(), /<html/i, "Workshop serves HTML");
console.log("PASS Workshop serves HTML on port 8787");

const assetsDir = resolve("packages/workshop-frontend/dist/assets");
const scripts = readdirSync(assetsDir).filter(name => name.endsWith(".js"));
assert(scripts.length > 0, "Frontend build must contain JavaScript chunks");
for (const name of scripts) {
  const response = await fetch(`http://127.0.0.1:8787/assets/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `Chunk ${name} must load`);
  assert.match(response.headers.get("content-type") ?? "", /javascript/, `Chunk ${name} must not fall back to HTML`);
  assert(await response.text() === readFileSync(resolve(assetsDir, name), "utf8"),
    `Chunk ${name} must match the current build`);
}
console.log(`PASS all ${scripts.length} JavaScript chunks match the build and have JavaScript MIME types`);

if (mode === "plain") {
  assert.equal(broker, undefined, "Plain mode must not contain a broker binding");
  console.log("PASS plain mode has no ChatGPT broker binding");
} else {
  assert(broker && typeof broker.secret === "string" && broker.secret.length >= 32,
    "ChatGPT mode requires a launch capability");
  const url = new URL(broker.url);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.equal(url.pathname, "/");
  ports.push(Number(url.port));
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "Broker config must be owner-only");
  if (logPath) {
    assert(!readFileSync(logPath, "utf8").includes(broker.secret),
      "Launch log contains the broker capability; do not print it");
    console.log("PASS launch log does not contain the current broker capability");
  }
  // A fresh, unregistered owner avoids reading any person's saved credentials.
  const auth = {
    authorization: `Bearer ${broker.secret}`,
    "x-workshop-user-id": `verification-${randomUUID()}`,
  };
  const probes = [
    { name: "missing capability", path: "/status", status: 401, code: "unauthorized" },
    { name: "wrong capability", path: "/status", headers: { ...auth, authorization: "Bearer invalid" }, status: 401, code: "unauthorized" },
    { name: "missing owner", path: "/status", headers: { authorization: auth.authorization }, status: 401, code: "invalid_user" },
    { name: "browser Origin", path: "/status", headers: { ...auth, origin: "http://localhost:8787" }, status: 403, code: "browser_request_denied" },
    { name: "browser Fetch Metadata", path: "/status", headers: { ...auth, "sec-fetch-site": "same-origin" }, status: 403, code: "browser_request_denied" },
    { name: "foreign Host", path: "/status", headers: { ...auth, host: "example.invalid" }, status: 403, code: "invalid_host" },
    { name: "unknown path", path: "/not-a-broker-route", headers: auth, status: 404, code: "not_found" },
    { name: "unexpected query", path: "/status?unexpected=1", headers: auth, status: 400, code: "unexpected_query" },
    { name: "invalid callback state", path: "/auth/callback?state=verification-invalid", status: 400, code: "invalid_state" },
    { name: "unregistered owner status", path: "/status", headers: auth, status: 200 },
    { name: "models fail closed", path: "/models", headers: auth, status: 401, code: "not_connected" },
    { name: "inference fails closed", path: "/responses", method: "POST", headers: auth, status: 401, code: "not_connected" },
  ];
  for (const probe of probes) {
    // Node's fetch replaces a supplied Host header, so use HTTP for the Host rejection probe.
    const response = await new Promise((resolveResponse, reject) => {
      const req = request(new URL(probe.path, url), {
        method: probe.method,
        headers: probe.headers,
        signal: AbortSignal.timeout(10000),
      }, resolveResponse);
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.statusCode, probe.status, probe.name);
    let text = "";
    for await (const chunk of response) text += chunk;
    const body = JSON.parse(text);
    if (probe.code) assert.equal(body.error?.code, probe.code, probe.name);
    else assert.deepEqual(body, { connected: false, status: "disconnected", sharing: false });
    console.log(`PASS ${probe.name}`);
  }
}

for (const port of ports) {
  assert(Number.isInteger(port) && port > 0 && port < 65536);
  const sockets = execFileSync("ss", ["-H", "-ltn", `sport = :${port}`], { encoding: "utf8" }).trim().split("\n");
  assert(sockets.length > 0 && sockets[0], `Port ${port} must be listening`);
  for (const socket of sockets) {
    assert.equal(socket.trim().split(/\s+/)[3], `127.0.0.1:${port}`, `Port ${port} must bind only IPv4 loopback`);
  }
  console.log(`PASS port ${port} listens only on 127.0.0.1`);
}
