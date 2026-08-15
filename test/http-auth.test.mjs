import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createHttpApp } from "../dist/index.js";

const env = {
  CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  CF_ACCESS_AUD: "gradescope-mcp-audience",
  LOCAL_AUTH_BYPASS: "false",
};

const fixture = await (async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "http-test-access-key";
  const token = await new SignJWT({
    email: "owner@example.edu",
    name: "Owner",
  })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer("https://team.cloudflareaccess.com")
    .setAudience("gradescope-mcp-audience")
    .setSubject("owner-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  return {
    keySet: createLocalJWKSet({ keys: [publicJwk] }),
    token,
  };
})();

async function listen(app) {
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("protects /mcp while keeping the health probe public", async () => {
  const app = createHttpApp(
    { fetchPage: async () => "<html></html>" },
    { environment: env, keySet: fixture.keySet }
  );
  const listener = await listen(app);

  try {
    const health = await fetch(`${listener.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const unauthorized = await fetch(`${listener.baseUrl}/mcp`, {
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(await unauthorized.text(), "Forbidden");

    const authorized = await fetch(`${listener.baseUrl}/mcp`, {
      headers: {
        Accept: "text/event-stream",
        "Cf-Access-Jwt-Assertion": fixture.token,
      },
    });
    assert.equal(authorized.status, 405);
    assert.equal(authorized.headers.get("allow"), "POST");
  } finally {
    await new Promise((resolve, reject) =>
      listener.server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
