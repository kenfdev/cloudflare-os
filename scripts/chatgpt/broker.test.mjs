import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startBroker } from "./broker.mjs";
import { tokenFields } from "./oauth.mjs";
import { proxyResponses } from "./responses.ts";

const secret = "s".repeat(43);
function fixture(overrides = {}) {
  const records = new Map();
  let attempt;
  let refreshes = 0;
  const store = {
    get: async (key) => structuredClone(records.get(key)),
    set: async (key, value) => {
      records.set(key, structuredClone(value));
    },
  };
  const oauth = {
    authorization: async (flow) => {
      attempt = flow;
      return `https://auth.openai.com/authorize?state=${flow.state}`;
    },
    exchange: async () => ({
      access_token: "private-access",
      refresh_token: "private-refresh",
      id_token: "private-id",
      scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
      token_type: "Bearer",
      expires_in: 3600,
    }),
    verify: async () => ({ subject: "subject-a", identity: { email: "test@example.invalid" } }),
    refresh: async () => {
      refreshes++;
      return {
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      };
    },
    revoke: async () => true,
    ...overrides,
  };
  return {
    store,
    records,
    oauth,
    get attempt() {
      return attempt;
    },
    get refreshes() {
      return refreshes;
    },
  };
}
async function setup(t, fixtureOverrides = {}, options = {}) {
  const f = fixture(fixtureOverrides);
  const broker = await startBroker({ secret, store: f.store, oauth: f.oauth, ...options });
  t.after(() => broker.close());
  const call = (path, method = "GET", user = "alice", headers = {}) =>
    fetch(broker.url + path, {
      method,
      headers: { authorization: `Bearer ${secret}`, "x-workshop-user-id": user, ...headers },
    });
  const login = async () => {
    assert.equal((await call("/start", "POST")).status, 200);
    const response = await fetch(
      `${broker.url}/auth/callback?state=${f.attempt.state}&code=code&client_id=registered-client`,
    );
    assert.equal(response.status, 200);
  };
  return { f, broker, call, login };
}
test("loopback API denies unauthenticated, browser-origin, wrong Host, invalid user and arbitrary proxy paths", async (t) => {
  const { broker, call } = await setup(t);
  assert.equal((await fetch(broker.url + "/status")).status, 401);
  assert.equal(
    (await call("/status", "GET", "alice", { origin: "https://evil.invalid" })).status,
    403,
  );
  assert.equal(
    (await call("/status", "GET", "alice", { "sec-fetch-site": "cross-site" })).status,
    403,
  );
  const wrongHost = await new Promise((resolve) => {
    http.get(broker.url + "/status", { headers: { host: "evil.invalid" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(wrongHost, 403);
  assert.equal((await call("/status", "GET", "../alice")).status, 401);
  assert.equal((await call("/anything")).status, 404);
  assert.equal((await call("/models?url=https://evil.invalid")).status, 400);
});

test("inference forwards sanitized HTTP errors and request IDs through the loopback broker", async (t) => {
  const { broker, login } = await setup(t, {}, {
    responseProxy: options => proxyResponses({ ...options,
      fetchImpl: async () => Response.json({ error: {
        code: "invalid_parameter", param: "prompt_cache_breakpoint", message: "private-prompt private-access",
      } }, { status: 400, headers: { "x-request-id": "req_test" } }),
    }),
  });
  await login();
  const response = await fetch(`${broker.url}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-workshop-user-id": "alice", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", input: [{ role: "user", content: "test" }] }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("x-request-id"), "req_test");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.match(body, /invalid_parameter/);
  assert.match(body, /prompt_cache_breakpoint/);
  assert.doesNotMatch(body, /private-/);
});
test("callback binds owner; rejects invalid states/duplicates; consumes valid state once and redacts all tokens", async (t) => {
  const { f, broker, call } = await setup(t);
  await call("/start", "POST");
  const state = f.attempt.state;
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=bad&code=c&client_id=client`)).status,
    400,
  );
  assert.equal(
    (
      await fetch(
        `${broker.url}/auth/callback?state=${state}&state=${state}&code=c&client_id=client`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${state}&code=c&client_id=client`)).status,
    200,
  );
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${state}&code=c&client_id=client`)).status,
    400,
  );
  const alice = await (await call("/status")).json();
  const bob = await (await call("/status", "GET", "bob")).json();
  assert.equal(alice.connected, true);
  assert.equal(bob.connected, false);
  assert.doesNotMatch(JSON.stringify(alice), /private-|accessToken|refreshToken|clientId/);
});
test("expired or replaced flow is rejected; provider error consumes state", async (t) => {
  const { f, broker, call } = await setup(t);
  await call("/start", "POST");
  const old = f.attempt;
  await call("/start", "POST");
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${old.state}&code=c&client_id=client`)).status,
    400,
  );
  f.attempt.expiresAt = Date.now() - 1;
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${f.attempt.state}&code=c&client_id=client`))
      .status,
    400,
  );
  await call("/start", "POST");
  const state = f.attempt.state;
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${state}&error=access_denied`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${state}&code=c&client_id=client`)).status,
    400,
  );
});
test("returning client and identity cannot change; registration retained on logout", async (t) => {
  const { f, broker, call, login } = await setup(t);
  await login();
  await call("/start", "POST");
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${f.attempt.state}&code=c&client_id=other`))
      .status,
    400,
  );
  await call("/start", "POST");
  f.oauth.verify = async () => ({ subject: "subject-other" });
  assert.equal(
    (await fetch(`${broker.url}/auth/callback?state=${f.attempt.state}&code=c`)).status,
    400,
  );
  assert.equal(f.records.get("user:alice").subject, "subject-a");
  const host = f.records.get("host");
  assert.equal((await call("/logout", "POST")).status, 200);
  assert.equal((await (await call("/status")).json()).connected, false);
  assert.equal(f.records.get("user:alice").clientId, "registered-client");
  assert.equal(f.records.get("host"), host);
  assert.doesNotMatch(JSON.stringify(f.records.get("user:alice")), /private-/);
});
test("refresh is serialized and rotated before inference; model catalog is account filtered", async (t) => {
  const { f, call, login } = await setup(
    t,
    {},
    {
      fetcher: async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/models");
        assert.equal(options.headers.authorization, "Bearer rotated-access");
        assert.equal(options.redirect, "error");
        return Response.json({
          models: [
            { slug: "allowed", display_name: "Allowed", visibility: "list" },
            { slug: "hidden", visibility: "hidden" },
          ],
        });
      },
    },
  );
  await login();
  f.records.get("user:alice").expiresAt = 0;
  const responses = await Promise.all([call("/models"), call("/models"), call("/models")]);
  for (const response of responses)
    assert.deepEqual(await response.json(), {
      models: [{ slug: "allowed", displayName: "Allowed" }],
    });
  assert.equal(f.refreshes, 1);
  assert.equal(f.records.get("user:alice").refreshToken, "rotated-refresh");
});
test("logout invalidates an in-flight callback so it cannot restore credentials", async (t) => {
  let resolveExchange;
  let exchangeStarted;
  const started = new Promise((resolve) => {
    exchangeStarted = resolve;
  });
  const { f, broker, call } = await setup(t, {
    exchange: () => {
      exchangeStarted();
      return new Promise((resolve) => {
        resolveExchange = resolve;
      });
    },
  });
  await call("/start", "POST");
  const callback = fetch(
    `${broker.url}/auth/callback?state=${f.attempt.state}&code=c&client_id=client`,
  );
  await started;
  const logout = call("/logout", "POST");
  // Ensure logout has reached the server before finishing code exchange.
  await new Promise((resolve) => setTimeout(resolve, 30));
  resolveExchange({
    access_token: "secret",
    refresh_token: "refresh",
    id_token: "id",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
  });
  assert.equal((await callback).status, 409);
  assert.equal((await logout).status, 200);
  assert.equal(f.records.get("user:alice").accessToken, undefined);
});
test("rotation checkpoint survives identity verification outage without repeating refresh", async (t) => {
  const { f, call, login } = await setup(
    t,
    {},
    { fetcher: async () => Response.json({ models: [] }) },
  );
  await login();
  f.records.get("user:alice").expiresAt = 0;
  let refreshes = 0;
  f.oauth.refresh = async () => {
    refreshes++;
    return {
      access_token: "new",
      refresh_token: "new-refresh",
      id_token: "new-id",
      expires_in: 3600,
      token_type: "Bearer",
    };
  };
  f.oauth.verify = async () => {
    throw new Error("JWKS unavailable");
  };
  assert.equal((await call("/models")).status, 503);
  assert.equal(f.records.get("user:alice").pendingRotation.fields.refreshToken, "new-refresh");
  f.oauth.verify = async () => ({ subject: "subject-a" });
  assert.equal((await call("/models")).status, 200);
  assert.equal(refreshes, 1);
});
test("scope validation rejects incomplete tokens and does not infer sharing from identity", () => {
  assert.throws(() => tokenFields({ access_token: "a", token_type: "Bearer", expires_in: 3600 }));
  assert.throws(() =>
    tokenFields({
      scope: "offline_access",
      access_token: "a",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  assert.deepEqual(tokenFields({ scope: "openid profile email" }), {
    scopes: ["openid", "profile", "email"],
  });
  assert.throws(() =>
    tokenFields({
      scope: "resource.invoke chatgpt.tokens.use.direct",
      access_token: "a",
      token_type: "Bearer",
      expires_in: Infinity,
    }),
  );
});
test("logout racing refresh revokes the replacement token, never restores a session", async (t) => {
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let finish;
  let revoked;
  const { f, call, login } = await setup(
    t,
    {},
    { fetcher: async () => Response.json({ models: [] }) },
  );
  await login();
  f.records.get("user:alice").expiresAt = 0;
  f.oauth.refresh = () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  f.oauth.revoke = async (record) => {
    revoked = record.refreshToken;
    return true;
  };
  const models = call("/models");
  await startedPromise;
  const logout = call("/logout", "POST");
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish({
    access_token: "rotated",
    refresh_token: "replacement",
    token_type: "Bearer",
    expires_in: 3600,
  });
  assert.equal((await models).status, 409);
  assert.equal((await logout).status, 200);
  assert.equal(revoked, "replacement");
  assert.equal(f.records.get("user:alice").accessToken, undefined);
});
test("failed revocation is reported while local credentials and pending sign-ins are removed", async (t) => {
  const { f, broker, call, login } = await setup(t, { revoke: async () => false });
  await login();
  await call("/start", "POST");
  const state = f.attempt.state;
  const logout = await (await call("/logout", "POST")).json();
  assert.equal(logout.revoked, false);
  assert.match(logout.warning, /not confirmed/);
  assert.equal((await fetch(`${broker.url}/auth/callback?state=${state}&code=c`)).status, 400);
  assert.equal((await call("/models")).status, 401);
});
test("cancelled callback's failed revocation is not reported as successful logout", async (t) => {
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let finish;
  const { f, broker, call } = await setup(t, {
    exchange: () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    revoke: async (record) => !record.refreshToken,
  });
  await call("/start", "POST");
  const callback = fetch(
    `${broker.url}/auth/callback?state=${f.attempt.state}&code=c&client_id=client`,
  );
  await startedPromise;
  const logout = call("/logout", "POST");
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish({
    access_token: "a",
    refresh_token: "r",
    id_token: "id",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
  });
  assert.equal((await callback).status, 409);
  assert.equal((await (await logout).json()).revoked, false);
  assert.equal(f.records.get("user:alice").accessToken, undefined);
  assert.equal((await (await call("/logout", "POST")).json()).revoked, false);
});

