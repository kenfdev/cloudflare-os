import { createHash, randomBytes } from "node:crypto";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const randomSecret = () => randomBytes(32).toString("base64url");
export class BrokerError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Verified discovery is confined to OpenAI, including redirects and JWKS retrieval. */
export function createOAuth(fetcher = fetch) {
  let discovery;
  let keys;
  const request = (url, options = {}) =>
    fetcher(url, {
      ...options,
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  async function configuration() {
    if (!discovery) {
      discovery = (async () => {
        const response = await request(`${ISSUER}/.well-known/openid-configuration`);
        if (!response.ok) throw new BrokerError("discovery_unavailable", 503);
        const data = await response.json();
        if (data.issuer !== ISSUER) throw new BrokerError("invalid_discovery", 503);
        for (const field of [
          "authorization_endpoint",
          "token_endpoint",
          "jwks_uri",
          "revocation_endpoint",
        ]) {
          if (
            typeof data[field] !== "string" ||
            new URL(data[field]).origin !== ISSUER ||
            new URL(data[field]).username ||
            new URL(data[field]).password
          )
            throw new BrokerError("invalid_discovery", 503);
        }
        return data;
      })().catch((error) => {
        discovery = undefined;
        throw error;
      });
    }
    return discovery;
  }
  async function verify(idToken, clientId, nonce, receivedAt) {
    const config = await configuration();
    const { createRemoteJWKSet, customFetch, jwtVerify } = await import("jose");
    keys ??= createRemoteJWKSet(new URL(config.jwks_uri), {
      [customFetch]: request,
      timeoutDuration: 15000,
    });
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iss", "aud", "exp", "iat"],
      clockTolerance: 5,
      ...(receivedAt ? { currentDate: new Date(receivedAt) } : {}),
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
    )
      throw new BrokerError("invalid_identity");
    return {
      subject: payload.sub,
      identity: {
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      },
    };
  }
  async function token(params) {
    const config = await configuration();
    const response = await request(config.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: RESOURCE }),
    });
    if (!response.ok)
      throw new BrokerError(
        response.status === 400 ? "reauth_required" : "token_service_unavailable",
        503,
      );
    return response.json();
  }
  return {
    async authorization(attempt, hostId) {
      const config = await configuration();
      const url = new URL(config.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: attempt.clientId ?? "dynamic_agent_client",
        response_type: "code",
        redirect_uri: attempt.redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state: attempt.state,
        nonce: attempt.nonce,
        ext_agent_host_id: hostId,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
        ...(attempt.clientId ? {} : { agent_name_hint: "Cloudflare OS" }),
      }).toString();
      if (attempt.loginHint) url.searchParams.set("login_hint", attempt.loginHint);
      // Do not expose retained ID tokens through the browser-facing start response.
      return url.toString();
    },
    exchange: (attempt, code, clientId) =>
      token({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
      }),
    refresh: (record) =>
      token({
        grant_type: "refresh_token",
        client_id: record.clientId,
        refresh_token: record.refreshToken,
      }),
    verify,
    async revoke(record) {
      if (!record.refreshToken) return true;
      const config = await configuration();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await request(config.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: record.refreshToken,
              token_type_hint: "refresh_token",
              client_id: record.clientId,
            }),
          });
          await response.body?.cancel();
          if (response.status === 200) return true;
          if (response.status < 500) return false;
        } catch {
          /* A failed revocation must not prevent local sign-out. */
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return false;
    },
  };
}

/** Validate granted scopes and lifetimes, never infer inference permission from identity. */
export function tokenFields(data, previous) {
  const scope = data.scope ?? previous?.scopes?.join(" ");
  if (typeof scope !== "string") throw new BrokerError("invalid_token_response");
  const scopes = scope.split(/\s+/).filter(Boolean);
  const sharing =
    scopes.includes("chatgpt.tokens.use.direct") && scopes.includes("resource.invoke");
  if (!data.access_token && !sharing && !previous) return { scopes };
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 31536000 ||
    ((scopes.includes("offline_access") || previous) &&
      (typeof data.refresh_token !== "string" || !data.refresh_token))
  )
    throw new BrokerError("invalid_token_response");
  return {
    scopes,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
