import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createOAuth, ISSUER, RESOURCE } from "./oauth.mjs";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  const config = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
    token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
  };
  const requests = [];
  const fetcher = async (url, options) => {
    url = String(url);
    requests.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url.endsWith("openid-configuration")) return Response.json(config);
    if (url === config.jwks_uri) return Response.json({ keys: [jwk] });
    if (url === config.token_endpoint) return Response.json({ mock: true });
    throw new Error("Unexpected external request");
  };
  const sign = (claims = {}, key = privateKey) =>
    new SignJWT({ nonce: "nonce", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? "client")
      .setSubject(claims.sub ?? "subject")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(key);
  return { oauth: createOAuth(fetcher), config, requests, sign };
}
test("authorization uses dynamic public client, PKCE, state, nonce, host and exact callback", async () => {
  const { oauth, requests } = await fixture();
  const attempt = {
    state: "state",
    nonce: "nonce",
    verifier: "verifier",
    redirectUri: "http://127.0.0.1:1234/auth/callback",
  };
  const url = new URL(await oauth.authorization(attempt, "urn:uuid:host"));
  assert.equal(url.origin, ISSUER);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.notEqual(url.searchParams.get("code_challenge"), "verifier");
  assert.equal(url.searchParams.get("nonce"), "nonce");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("ext_agent_host_id"), "urn:uuid:host");
  await oauth.exchange(attempt, "code", "issued-client");
  const params = requests.at(-1).options.body;
  assert.equal(params.get("client_id"), "issued-client");
  assert.equal(params.get("redirect_uri"), attempt.redirectUri);
  assert.equal(params.get("resource"), RESOURCE);
  assert.equal(params.has("client_secret"), false);
});
test("ID-token verification cryptographically validates signature issuer audience expiry nonce and azp", async () => {
  const { oauth, sign } = await fixture();
  const valid = await sign({ email: "test@example.invalid" });
  assert.deepEqual(await oauth.verify(valid, "client", "nonce"), {
    subject: "subject",
    identity: { email: "test@example.invalid" },
  });
  for (const claims of [
    { nonce: "bad" },
    { iss: "https://evil.invalid" },
    { aud: "wrong-client" },
    { exp: 1 },
    { azp: "wrong" },
    { aud: ["client", "second"] },
  ]) {
    const signToken = await sign(claims);
    await assert.rejects(() => oauth.verify(signToken, "client", "nonce"));
  }
  const other = await generateKeyPair("RS256");
  const awaitInvalid = await sign({}, other.privateKey);
  await assert.rejects(() => oauth.verify(awaitInvalid, "client", "nonce"));
});
test("discovery cannot redirect token or JWKS traffic outside OpenAI", async () => {
  const { config } = await fixture();
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "revocation_endpoint",
  ]) {
    const oauth = createOAuth(async () =>
      Response.json({ ...config, [field]: "https://evil.invalid/steal" }),
    );
    await assert.rejects(() => oauth.authorization({}, "host"));
  }
});
