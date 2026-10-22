import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore } from "./credentials.mjs";
import { BrokerError, createOAuth, randomSecret, tokenFields, RESOURCE } from "./oauth.mjs";

const key = (user) => `user:${user}`;

function equalSecret(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new BrokerError("request_too_large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new BrokerError("invalid_json");
  }
}
function publicStatus(record, connecting, error) {
  return {
    connected: !!record?.accessToken,
    status: connecting ? "connecting" : record?.accessToken ? "connected" : "disconnected",
    sharing:
      !!record?.accessToken &&
      record.scopes.includes("chatgpt.tokens.use.direct") &&
      record.scopes.includes("resource.invoke"),
    ...(record?.identity ? { identity: record.identity } : {}),
    ...(error ? { error: { code: error } } : {}),
  };
}

/** A loopback-only broker; only the trusted local Workshop Worker receives its launch secret. */
export async function startBroker({
  secret,
  port = 0,
  store: injectedStore,
  oauth: injectedOAuth,
  fetcher = fetch,
  responseProxy,
} = {}) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("A strong per-launch broker secret is required.");
  let lockPath;
  // One broker per OS user prevents cross-process rotating-refresh races. An unclean
  // shutdown leaves a fail-closed lock; remove it only after checking no broker runs.
  if (!injectedStore) {
    lockPath = join(tmpdir(), `cloudflare-os-chatgpt-${process.getuid?.() ?? "user"}.lock`);
    await mkdir(lockPath, { mode: 0o700 }).catch(() => {
      throw new Error(
        `ChatGPT broker is already running or has an unclean-shutdown lock at ${lockPath}.`,
      );
    });
  }
  let store;
  try {
    store = injectedStore ?? (await createCredentialStore());
  } catch {
    if (lockPath) await rm(lockPath, { recursive: true });
    throw new Error("OS credential storage is unavailable; no plaintext fallback is allowed.");
  }
  const oauth = injectedOAuth ?? createOAuth(fetcher);
  let hostPromise;
  const getHost = () =>
    (hostPromise ??= (async () => {
      let host = await store.get("host");
      if (!host) {
        host = `urn:uuid:${randomUUID()}`;
        await store.set("host", host);
      }
      return host;
    })().catch((error) => {
      hostPromise = undefined;
      throw error;
    }));
  const pending = new Map();
  const generations = new Map();
  const queues = new Map();
  const errors = new Map();
  const requests = new Map();
  const generation = (user) => generations.get(user) ?? 0;
  function invalidate(user) {
    generations.set(user, generation(user) + 1);
    for (const [state, attempt] of pending) if (attempt.user === user) pending.delete(state);
    for (const controller of requests.get(user) ?? []) controller.abort();
  }
  function serialized(user, action) {
    const result = (queues.get(user) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(user, result);
    void result
      .finally(() => {
        if (queues.get(user) === result) queues.delete(user);
      })
      .catch(() => {});
    return result;
  }
  const checkGeneration = (user, value) => {
    if (generation(user) !== value) throw new BrokerError("cancelled", 409);
  };
  async function access(user) {
    return serialized(user, async () => {
      const gen = generation(user);
      let record = await store.get(key(user));
      if (!record?.subject || !record.accessToken) throw new BrokerError("not_connected", 401);
      if (
        !record.scopes.includes("chatgpt.tokens.use.direct") ||
        !record.scopes.includes("resource.invoke")
      )
        throw new BrokerError("sharing_not_enabled", 403);
      if (record.pendingRotation || record.expiresAt < Date.now() + 60000) {
        if (!record.pendingRotation) {
          const data = await oauth.refresh(record);
          const fields = tokenFields(data, record);
          if (data.id_token !== undefined && (typeof data.id_token !== "string" || !data.id_token))
            throw new BrokerError("invalid_identity");
          // Checkpoint rotation before JWKS retrieval. Never use it before validating
          // a returned identity; outages must not lose a consumed refresh grant.
          record = {
            ...record,
            pendingRotation: {
              fields,
              idToken: data.id_token,
              receivedAt: Date.now(),
            },
          };
          await store.set(key(user), record);
          checkGeneration(user, gen);
        }
        const rotation = record.pendingRotation;
        if (rotation.idToken) {
          const verified = await oauth.verify(
            rotation.idToken,
            record.clientId,
            undefined,
            rotation.receivedAt,
          );
          if (verified.subject !== record.subject) throw new BrokerError("account_mismatch", 401);
          record = { ...record, ...verified, idToken: rotation.idToken };
        }
        checkGeneration(user, gen);
        const { pendingRotation: _rotation, ...current } = record;
        record = { ...current, ...rotation.fields };
        await store.set(key(user), record);
      }
      checkGeneration(user, gen);
      if (
        !record.scopes.includes("chatgpt.tokens.use.direct") ||
        !record.scopes.includes("resource.invoke")
      )
        throw new BrokerError("sharing_not_enabled", 403);
      return record.accessToken;
    });
  }
  let base;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== new URL(base).host) throw new BrokerError("invalid_host", 403);
      const url = new URL(req.url, base);
      if (url.origin !== base) throw new BrokerError("invalid_host", 403);
      if (url.pathname === "/auth/callback" && req.method === "GET") {
        for (const field of ["state", "code", "client_id", "error"])
          if (url.searchParams.getAll(field).length > 1) throw new BrokerError("invalid_callback");
        const state = url.searchParams.get("state");
        const attempt = pending.get(state);
        if (!attempt || attempt.expiresAt < Date.now()) {
          pending.delete(state);
          throw new BrokerError("invalid_state");
        }
        pending.delete(state); // Consume before any asynchronous operation or provider call.
        await serialized(attempt.user, async () => {
          checkGeneration(attempt.user, attempt.generation);
          try {
            if (url.searchParams.has("error")) throw new BrokerError("authorization_denied");
            const code = url.searchParams.get("code");
            const clientId = url.searchParams.get("client_id") ?? attempt.clientId;
            if (
              !code ||
              !clientId ||
              !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) ||
              clientId === "dynamic_agent_client" ||
              (attempt.clientId && attempt.clientId !== clientId)
            )
              throw new BrokerError("invalid_registration");
            // Retain a newly issued client even when its one-time code expires.
            const previous = await store.get(key(attempt.user));
            await store.set(key(attempt.user), { ...previous, clientId });
            const data = await oauth.exchange(attempt, code, clientId);
            if (typeof data.id_token !== "string") throw new BrokerError("invalid_identity");
            const identity = await oauth.verify(data.id_token, clientId, attempt.nonce);
            if (attempt.subject && identity.subject !== attempt.subject)
              throw new BrokerError("account_mismatch");
            const fields = tokenFields(data);
            if (generation(attempt.user) !== attempt.generation) {
              const revoked = await oauth.revoke({ clientId, ...fields }).catch(() => false);
              if (!revoked)
                await store.set(key(attempt.user), {
                  ...previous,
                  clientId,
                  unconfirmedRevocation: true,
                });
              throw new BrokerError("cancelled", 409);
            }
            await store.set(key(attempt.user), {
              clientId,
              ...identity,
              ...fields,
              idToken: data.id_token,
              unconfirmedRevocation: previous?.unconfirmedRevocation,
            });
            errors.delete(attempt.user);
          } catch (error) {
            errors.set(attempt.user, error instanceof BrokerError ? error.code : "sign_in_failed");
            throw error;
          }
        });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ChatGPT connected. You can close this tab and return to Cloudflare OS.");
        return;
      }
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined)
        throw new BrokerError("browser_request_denied", 403);
      if (!equalSecret(req.headers.authorization, `Bearer ${secret}`))
        throw new BrokerError("unauthorized", 401);
      const user = req.headers["x-workshop-user-id"];
      if (typeof user !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(user))
        throw new BrokerError("invalid_user", 401);
      if (url.search) throw new BrokerError("unexpected_query");
      if (req.method === "GET" && url.pathname === "/status") {
        json(
          200,
          publicStatus(
            await store.get(key(user)),
            [...pending.values()].some((x) => x.user === user && x.expiresAt > Date.now()),
            errors.get(user),
          ),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/start") {
        invalidate(user);
        const gen = generation(user);
        const result = await serialized(user, async () => {
          const record = await store.get(key(user));
          const host = await getHost();
          const attempt = {
            user,
            generation: gen,
            state: randomSecret(),
            nonce: randomSecret(),
            verifier: randomSecret(),
            clientId: record?.clientId,
            subject: record?.subject,
            loginHint: record?.identity?.email,
            redirectUri: `${base}/auth/callback`,
            expiresAt: Date.now() + 5 * 60 * 1000,
          };
          const authorizationUrl = await oauth.authorization(attempt, host);
          checkGeneration(user, gen);
          for (const [state, flow] of pending)
            if (flow.expiresAt < Date.now()) pending.delete(state);
          if (pending.size >= 100) throw new BrokerError("too_many_attempts", 429);
          pending.set(attempt.state, attempt);
          errors.delete(user);
          return { authorizationUrl };
        });
        json(200, result);
        return;
      }
      if (req.method === "POST" && url.pathname === "/logout") {
        invalidate(user);
        errors.delete(user);
        const remoteRevoked = await serialized(user, async () => {
          const record = await store.get(key(user));
          if (!record) return true;
          let revoked = false;
          try {
            revoked = await oauth.revoke({
              ...record,
              refreshToken: record.pendingRotation?.fields.refreshToken ?? record.refreshToken,
            });
          } catch {
            /* Clear local credentials even if the provider is unreachable. */
          }
          await store.set(key(user), {
            clientId: record.clientId,
            subject: record.subject,
            identity: record.identity,
            scopes: [],
            unconfirmedRevocation: !!record.unconfirmedRevocation || !revoked,
          });
          return revoked && !record.unconfirmedRevocation;
        });
        json(200, {
          connected: false,
          revoked: remoteRevoked,
          ...(!remoteRevoked
            ? {
                warning:
                  "Remote revocation was not confirmed. Disconnect this app in ChatGPT Settings.",
              }
            : {}),
        });
        return;
      }
      if (
        (req.method === "GET" && url.pathname === "/models") ||
        (req.method === "POST" && url.pathname === "/responses")
      ) {
        const controller = new AbortController();
        const active = requests.get(user) ?? new Set();
        active.add(controller);
        requests.set(user, active);
        const abort = () => controller.abort();
        req.once("aborted", abort);
        res.once("close", abort);
        try {
          const accessToken = await access(user);
          controller.signal.throwIfAborted();
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
          if (url.pathname === "/models") {
            const response = await fetcher(`${RESOURCE}/models`, {
              headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
              redirect: "error",
              signal,
            });
            if (!response.ok)
              throw new BrokerError(
                "model_catalog_unavailable",
                response.status === 401 ? 401 : 502,
              );
            const body = await response.json();
            if (!Array.isArray(body.models)) throw new BrokerError("invalid_model_catalog", 502);
            const models = body.models
              .filter((model) => model.visibility === "list")
              .map((model) => {
                if (
                  typeof model.slug !== "string" ||
                  !model.slug ||
                  typeof model.display_name !== "string"
                )
                  throw new BrokerError("invalid_model_catalog", 502);
                return { slug: model.slug, displayName: model.display_name };
              });
            json(200, { models });
            return;
          }
          const body = await readBody(req);
          const proxy = responseProxy ?? (await import("./responses.ts")).proxyResponses;
          const response = await proxy({ body, accessToken, signal });
          res.writeHead(response.status, {
            "content-type": response.headers.get("content-type") ?? "text/event-stream",
            "cache-control": "no-store",
            ...(response.headers.has("x-request-id")
              ? { "x-request-id": response.headers.get("x-request-id") } : {}),
          });
          if (response.body)
            for await (const chunk of response.body) {
              signal.throwIfAborted();
              if (!res.write(chunk))
                await new Promise((resolve, reject) => {
                  res.once("drain", resolve);
                  res.once("error", reject);
                  res.once("close", reject);
                });
            }
          res.end();
          return;
        } finally {
          active.delete(controller);
          if (!active.size) requests.delete(user);
          req.removeListener("aborted", abort);
          res.removeListener("close", abort);
        }
      }
      throw new BrokerError("not_found", 404);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        json(error instanceof BrokerError ? error.status : 503, {
          error: { code: error instanceof BrokerError ? error.code : "broker_unavailable" },
        });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    if (lockPath) await rm(lockPath, { recursive: true });
    throw error;
  }
  return {
    url: base,
    async close() {
      for (const user of new Set([...generations.keys(), ...requests.keys(), ...queues.keys()]))
        invalidate(user);
      pending.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled(queues.values());
      if (lockPath) await rm(lockPath, { recursive: true });
    },
  };
}

