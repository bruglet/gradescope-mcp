# @tasque/gradescope-mcp

A student-focused, read-only MCP server for Gradescope. It uses Gradescope's authenticated HTML pages because Gradescope does not provide an official public API.

This is a self-hosted fork of [TylerFlar/claude-gradescope-mcp](https://github.com/TylerFlar/claude-gradescope-mcp), reduced to the student read-only surface and packaged for rootless Podman/Cloudflare Tunnel deployment.

> Gradescope's pages and undocumented endpoints may change, and this scraper may be subject to Gradescope's Terms of Service. Use it only with an account and access you are authorized to use.

## Current tools

The production surface contains the five student-data tools below plus one
optional read-only tool for downloading an assignment-provided PDF:

> Temporary diagnostics: this branch additionally exposes `diagnose-course` and
> `diagnose-submission`. They are read-only and intentionally temporary; they
> will be removed after the live parser repairs are complete.
> They are not part of the normal production surface.

| Tool | Purpose |
|------|---------|
| `list-courses` | Lists courses under the logged-in account's Student Courses section. |
| `list-assignments` | Lists a student's assignments with due dates, late due dates, status, timestamps, lateness, scores, release state, and URLs when available. |
| `list-submissions` | Lists the student's submission attempts for an assignment. |
| `get-submission` | Returns one owned submission with summary fields, question scores, rubric items, and grader comments. |
| `list-regrade-requests` | Lists the student's regrade requests and their status, explanation, response, and request time when available. |
| `download-assignment-pdf` | Fetches the current provided PDF for an assignment when one exists and returns it as an embedded PDF resource. |

The data tools publish structured output and also include the same JSON as text content. The PDF tool returns structured availability metadata plus the embedded PDF resource; it does not return the expiring signed URL. Course, assignment, and submission IDs are validated as numeric strings. Course-scoped tools verify that the course appears under Student Courses before requesting course data; instructor, TA, unknown, and absent courses fail closed.

## Read-only guarantee

The MCP surface contains no submission, regrade-creation, extension, grading, roster, grade-export, debug-page, or other mutation tool. The Gradescope client exposes authenticated page GETs plus a narrowly restricted GET for the current Gradescope-provided PDF. Its only outbound non-GET request is the required form POST to `/login`; same-origin URLs and redirects are enforced before Gradescope cookies are attached, and redirects are bounded. PDF downloads use the fresh signed upload URL from the student course page without sending Gradescope cookies, accept only the known Gradescope PDF-upload path, and are capped at 25 MiB.

Authentication cookies are held in memory and are never written to the repository or disk. Never commit credentials, cookies, CSRF tokens, raw account pages, or student data.

## Authentication

Set the following environment variables:

- `GRADESCOPE_EMAIL`
- `GRADESCOPE_PASSWORD`

For HTTP deployment, the service expects Cloudflare Access to protect the public hostname and also verifies the signed Access assertion at the origin. Set these additional variables:

- `CF_ACCESS_TEAM_DOMAIN` — the Access team domain, such as `your-team.cloudflareaccess.com`. An `https://` prefix is also accepted, but paths, ports, query strings, and non-HTTPS domains are rejected.
- `CF_ACCESS_AUD` — the Access application audience (AUD) tag for this MCP application.

The middleware validates the `Cf-Access-Jwt-Assertion` signature using the team JWKS endpoint and checks the RS256 algorithm, issuer, audience, expiration, and subject. Missing or invalid configuration and missing, forged, expired, or mismatched assertions all receive a generic `403 Forbidden` before an MCP server or Gradescope request is created. The middleware does not trust an email claim for authorization; restrict the allowed identity in the Cloudflare Access application policy.

`/healthz` remains public for container health probes. It does not expose account data. `MCP_ALLOWED_EMAIL` is not used by this project.

For local HTTP development only, set `LOCAL_AUTH_BYPASS=true`. This bypass works only for an actual loopback connection using an `http://localhost`, `http://127.0.0.1`, or `http://[::1]` URL. It cannot be enabled by spoofing a `Host` header, and it must never be enabled in the deployed environment. Stdio mode does not use HTTP authentication.

## Run locally

Install dependencies and run the build plus fixture tests:

```sh
npm ci
npm test
```

Run in stdio mode:

```sh
GRADESCOPE_EMAIL='student@example.edu' \
GRADESCOPE_PASSWORD='use-a-secret-store' \
npm start
```

Run the HTTP transport on port 3100:

```sh
LOCAL_AUTH_BYPASS=true MCP_TRANSPORT=http MCP_PORT=3100 npm start
```

The MCP endpoint is `POST /mcp`; `GET /healthz` returns a simple process-health response. The HTTP transport is stateless: each request receives a fresh MCP server/transport while the process-wide Gradescope client serializes authenticated page access and retains its in-memory session.

For a deployed HTTP process, omit the bypass and provide the Access settings instead:

```sh
CF_ACCESS_TEAM_DOMAIN='your-team.cloudflareaccess.com' \
CF_ACCESS_AUD='your-access-application-audience' \
MCP_TRANSPORT=http MCP_PORT=3100 npm start
```

Cloudflare Access must still be configured in front of the public hostname; this origin check is defense in depth, not a replacement for the Access application or its identity policy. Do not expose port 3100 directly to the Internet.

## Container and home-server deployment

The repository includes a multi-stage production `Dockerfile`, a manual GitHub Actions workflow that publishes to GHCR, and a rootless Podman Quadlet at [`deploy/gradescope-mcp.container`](deploy/gradescope-mcp.container). The image contains only the compiled server and production dependencies, runs as the unprivileged `node` user, exposes `/healthz` for probes, and does not contain credentials or configuration.

The workflow publishes `ghcr.io/<owner>/<repository>:latest` plus an immutable commit tag. It is intentionally manual so an image is not published merely because a branch changes. The workflow requires the repository's automatic `GITHUB_TOKEN` package-write permission; it does not require a long-lived registry token. If GitHub initially marks the new GHCR package private, change the package visibility to public in the package settings before pulling it anonymously from the home server.

On the home server, install the Quadlet as the `host` user:

```sh
mkdir -p ~/.config/gradescope-mcp ~/.config/containers/systemd
cp deploy/gradescope-mcp.env.example ~/.config/gradescope-mcp/gradescope-mcp.env
chmod 600 ~/.config/gradescope-mcp/gradescope-mcp.env
# Edit the copied env file with the real Gradescope and Access values.
cp deploy/gradescope-mcp.container ~/.config/containers/systemd/gradescope-mcp.container
systemctl --user daemon-reload
systemctl --user enable --now gradescope-mcp.service
systemctl --user status gradescope-mcp.service
curl --fail http://127.0.0.1:3100/healthz
```

The Quadlet deliberately publishes only to loopback. Add the public MCP hostname and `http://127.0.0.1:3100` origin to the existing Cloudflare Tunnel ingress according to the home-server tunnel procedure, and put the Cloudflare Access application/policy in front of that hostname. No Cloudflare credentials or tunnel configuration belong in this repository. `AutoUpdate=registry` follows the host's existing Podman auto-update convention; use an immutable `sha-...` image tag in the Quadlet when reviewed, reproducible rollouts are preferred.

## Development status

The self-hosting refactor restores the upstream Node/Express shape while retaining only the student read-only core. Cloudflare Access JWT verification and container/Quadlet packaging are implemented for the self-hosted HTTP path. Tunnel deployment and live validation remain host/account-specific steps. The assignment and submission parsers have been live-validated against current student pages; temporary diagnostics remain until the final cleanup step.
