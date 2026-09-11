import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type {
  NextFunction,
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
} from "express";

const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["::1", "127.0.0.1"]);

export interface AccessEnvironment {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  LOCAL_AUTH_BYPASS?: string;
}

export interface AccessIdentity {
  subject: string;
  email: string | null;
  name: string | null;
}

export interface AccessConfiguration {
  issuer: string;
  audience: string;
  jwksUrl: URL;
}

export interface AccessMiddlewareOptions {
  keySet?: JWTVerifyGetKey;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function normalizeTeamDomain(value: string): URL | null {
  try {
    const domainUrl = new URL(
      value.includes("://") ? value : `https://${value}`
    );

    if (
      domainUrl.protocol !== "https:" ||
      domainUrl.pathname !== "/" ||
      domainUrl.search ||
      domainUrl.hash ||
      domainUrl.username ||
      domainUrl.password ||
      domainUrl.port
    ) {
      return null;
    }

    return domainUrl;
  } catch {
    return null;
  }
}

/** Return the configured Cloudflare Access issuer, audience, and JWKS URL. */
export function getAccessConfiguration(
  env: Pick<AccessEnvironment, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD">
): AccessConfiguration | null {
  const configuredDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!configuredDomain || !audience) return null;

  const domainUrl = normalizeTeamDomain(configuredDomain);
  if (!domainUrl) return null;

  const issuer = domainUrl.origin;
  return {
    issuer,
    audience,
    jwksUrl: new URL("/cdn-cgi/access/certs", `${issuer}/`),
  };
}

function remoteKeySetFor(configuration: AccessConfiguration): JWTVerifyGetKey {
  const existing = remoteKeySets.get(configuration.issuer);
  if (existing) return existing;

  const keySet = createRemoteJWKSet(configuration.jwksUrl);
  remoteKeySets.set(configuration.issuer, keySet);
  return keySet;
}

function identityFromPayload(payload: JWTPayload): AccessIdentity | null {
  const subject =
    typeof payload.sub === "string" && payload.sub.length > 0
      ? payload.sub
      : typeof payload.common_name === "string" && payload.common_name.length > 0
        ? payload.common_name
        : null;
  if (!subject) return null;

  return {
    subject,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

/** Verify the signed application assertion forwarded by Cloudflare Access. */
export async function verifyAccessJwt(
  request: Request,
  env: Pick<AccessEnvironment, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD">,
  keySet?: JWTVerifyGetKey
): Promise<AccessIdentity | null> {
  const token = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim();
  if (!token) return null;

  const configuration = getAccessConfiguration(env);
  if (!configuration) return null;

  try {
    const { payload } = await jwtVerify(
      token,
      keySet ?? remoteKeySetFor(configuration),
      {
        algorithms: ["RS256"],
        issuer: configuration.issuer,
        audience: configuration.audience,
      }
    );
    return identityFromPayload(payload);
  } catch {
    // Authentication failures intentionally have no token or upstream error
    // details. They are expected at the edge when a request is unauthenticated.
    return null;
  }
}

/**
 * Check whether the explicit development bypass is requested for a loopback
 * URL. The Express middleware also requires the actual socket peer to be
 * loopback, so a public caller cannot bypass auth by spoofing Host.
 */
export function isLocalAuthBypassAllowed(
  request: Request,
  env: Pick<AccessEnvironment, "LOCAL_AUTH_BYPASS">
): boolean {
  if (String(env.LOCAL_AUTH_BYPASS) !== "true") return false;

  try {
    const url = new URL(request.url);
    return url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return (
    LOOPBACK_ADDRESSES.has(normalized) ||
    normalized.startsWith("127.")
  );
}

function expressRequestToWebRequest(request: ExpressRequest): Request | null {
  const host = request.get("host");
  if (!host) return null;

  try {
    const protocol = request.protocol === "https" ? "https" : "http";
    const url = new URL(request.originalUrl || request.url, `${protocol}://${host}`);
    const headers = new Headers();
    const assertion = request.get(ACCESS_ASSERTION_HEADER);
    if (assertion) headers.set(ACCESS_ASSERTION_HEADER, assertion);
    return new Request(url, { headers });
  } catch {
    return null;
  }
}

/**
 * Authenticate a request using Cloudflare Access or an explicitly authorized
 * loopback development bypass.
 */
export async function authenticateAccessRequest(
  request: Request,
  env: AccessEnvironment,
  keySet?: JWTVerifyGetKey,
  actualConnectionIsLoopback = false
): Promise<boolean> {
  if (
    actualConnectionIsLoopback &&
    isLocalAuthBypassAllowed(request, env)
  ) {
    return true;
  }

  return (await verifyAccessJwt(request, env, keySet)) !== null;
}

export function sendAuthenticationFailure(response: ExpressResponse): void {
  response
    .status(403)
    .set("Cache-Control", "no-store")
    .set("X-Content-Type-Options", "nosniff")
    .type("text")
    .send("Forbidden");
}

/** Express middleware for the externally exposed MCP route. */
export function createAccessMiddleware(
  env: AccessEnvironment = process.env,
  options: AccessMiddlewareOptions = {}
): RequestHandler {
  return async (
    request: ExpressRequest,
    response: ExpressResponse,
    next: NextFunction
  ): Promise<void> => {
    const webRequest = expressRequestToWebRequest(request);
    const authenticated = webRequest
      ? await authenticateAccessRequest(
          webRequest,
          env,
          options.keySet,
          isLoopbackAddress(request.socket.remoteAddress)
        )
      : false;

    if (authenticated) {
      next();
      return;
    }
    sendAuthenticationFailure(response);
  };
}
