import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  authenticateAccessRequest,
  createAccessMiddleware,
  getAccessConfiguration,
  isLocalAuthBypassAllowed,
  verifyAccessJwt,
} from "../dist/access-auth.js";

const env = {
  CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  CF_ACCESS_AUD: "gradescope-mcp-audience",
  LOCAL_AUTH_BYPASS: "false",
};

const fixture = await (async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-access-key";
  return {
    keySet: createLocalJWKSet({ keys: [publicJwk] }),
    privateKey,
    keyId: publicJwk.kid,
  };
})();

function request(url, headers = {}) {
  return new Request(url, { headers });
}

async function accessToken(claims = {}, options = {}) {
  const builder = new SignJWT({
    email: "owner@example.edu",
    name: "Owner",
    ...claims,
  })
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: fixture.keyId })
    .setIssuer(options.issuer ?? "https://team.cloudflareaccess.com")
    .setAudience(options.audience ?? "gradescope-mcp-audience")
    .setSubject(options.subject ?? "owner-subject");

  if (options.expired) {
    const now = Math.floor(Date.now() / 1000);
    builder.setIssuedAt(now - 120).setExpirationTime(now - 60);
  } else {
    builder.setIssuedAt().setExpirationTime("5m");
  }

  return builder.sign(options.privateKey ?? fixture.privateKey);
}

function expressRequest({
  host = "gradescope-mcp.example",
  protocol = "https",
  url = "/mcp",
  token,
  remoteAddress = "203.0.113.20",
} = {}) {
  const headers = new Map();
  if (token) headers.set("cf-access-jwt-assertion", token);
  return {
    protocol,
    originalUrl: url,
    url,
    socket: { remoteAddress },
    get(name) {
      if (name.toLowerCase() === "host") return host;
      return headers.get(name.toLowerCase());
    },
  };
}

function expressResponse() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    type(value) {
      this.headers.set("content-type", value);
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

async function runMiddleware(requestOptions, middlewareOptions = {}) {
  const response = expressResponse();
  let nextCalled = false;
  const middleware = createAccessMiddleware(env, {
    keySet: fixture.keySet,
    ...middlewareOptions,
  });
  await middleware(
    expressRequest(requestOptions),
    response,
    () => {
      nextCalled = true;
    }
  );
  return { response, nextCalled };
}

test("builds a same-origin Access issuer and JWKS endpoint", () => {
  assert.deepEqual(getAccessConfiguration(env), {
    issuer: "https://team.cloudflareaccess.com",
    audience: "gradescope-mcp-audience",
    jwksUrl: new URL(
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs"
    ),
  });
  assert.equal(
    getAccessConfiguration({
      CF_ACCESS_TEAM_DOMAIN: "http://team.cloudflareaccess.com",
      CF_ACCESS_AUD: env.CF_ACCESS_AUD,
    }),
    null
  );
  assert.equal(
    getAccessConfiguration({
      CF_ACCESS_TEAM_DOMAIN: "ismind.cloudflareaccess.com/path",
      CF_ACCESS_AUD: env.CF_ACCESS_AUD,
    }),
    null
  );
});

test("accepts a valid Cloudflare Access application assertion", async () => {
  const token = await accessToken();
  const identity = await authenticateAccessRequest(
    request("https://gradescope-mcp.example/mcp", {
      "Cf-Access-Jwt-Assertion": token,
    }),
    env,
    fixture.keySet
  );
  assert.equal(identity, true);
});

test("accepts a Cloudflare Access service-token assertion", async () => {
  const token = await accessToken(
    {
      common_name: "service-token.access",
      email: null,
      name: null,
    },
    { subject: "" }
  );
  const identity = await verifyAccessJwt(
    request("https://gradescope-mcp.example/mcp", {
      "Cf-Access-Jwt-Assertion": token,
    }),
    env,
    fixture.keySet
  );
  assert.deepEqual(identity, {
    subject: "service-token.access",
    email: null,
    name: null,
  });
});

test("rejects missing, forged, expired, and mismatched Access assertions", async () => {
  const { privateKey: forgedPrivateKey } = await generateKeyPair("RS256");
  const forgedToken = await accessToken({}, { privateKey: forgedPrivateKey });
  const wrongIssuerToken = await accessToken({}, {
    issuer: "https://other.cloudflareaccess.com",
  });
  const wrongAudienceToken = await accessToken({}, {
    audience: "different-audience",
  });
  const expiredToken = await accessToken({}, { expired: true });
  const missingSubjectToken = await accessToken({}, { subject: "" });

  for (const token of [
    undefined,
    forgedToken,
    wrongIssuerToken,
    wrongAudienceToken,
    expiredToken,
    missingSubjectToken,
  ]) {
    const headers = token
      ? { "Cf-Access-Jwt-Assertion": token }
      : {};
    assert.equal(
      await authenticateAccessRequest(
        request("https://gradescope-mcp.example/mcp", headers),
        env,
        fixture.keySet
      ),
      false
    );
  }
});

test("the local bypass requires an explicit flag, loopback URL, and loopback peer", async () => {
  const localEnv = { ...env, LOCAL_AUTH_BYPASS: "true" };
  const localRequest = request("http://localhost:3100/mcp");

  assert.equal(isLocalAuthBypassAllowed(localRequest, localEnv), true);
  assert.equal(
    await authenticateAccessRequest(localRequest, localEnv, undefined, true),
    true
  );
  assert.equal(
    await authenticateAccessRequest(localRequest, localEnv, undefined, false),
    false
  );
  assert.equal(
    isLocalAuthBypassAllowed(
      request("https://localhost:3100/mcp"),
      localEnv
    ),
    false
  );
  assert.equal(
    isLocalAuthBypassAllowed(
      request("http://gradescope-mcp.example/mcp"),
      localEnv
    ),
    false
  );
});

test("Express middleware denies unauthenticated MCP requests", async () => {
  const result = await runMiddleware();
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body, "Forbidden");
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(
    result.response.headers.get("x-content-type-options"),
    "nosniff"
  );
});

test("Express middleware allows a valid assertion and rejects a spoofed local host", async () => {
  const token = await accessToken();
  const allowed = await runMiddleware({ token });
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.response.statusCode, 200);

  const localEnv = { ...env, LOCAL_AUTH_BYPASS: "true" };
  const response = expressResponse();
  let nextCalled = false;
  const middleware = createAccessMiddleware(localEnv, {
    keySet: fixture.keySet,
  });
  await middleware(
    expressRequest({
      host: "localhost:3100",
      protocol: "http",
      remoteAddress: "203.0.113.20",
    }),
    response,
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
});
