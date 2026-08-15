# @tasque/gradescope-mcp

A student-focused, read-only MCP server for Gradescope. It uses Gradescope's authenticated HTML pages because Gradescope does not provide an official public API.

> Gradescope's pages and undocumented endpoints may change, and this scraper may be subject to Gradescope's Terms of Service. Use it only with an account and access you are authorized to use.

## Current tools

The server exposes exactly these five MCP tools:

| Tool | Purpose |
|------|---------|
| `list-courses` | Lists courses under the logged-in account's Student Courses section. |
| `list-assignments` | Lists a student's assignments with due dates, late due dates, status, timestamps, lateness, scores, release state, and URLs when available. |
| `list-submissions` | Lists the student's submission attempts for an assignment. |
| `get-submission` | Returns one owned submission with summary fields, question scores, rubric items, and grader comments. |
| `list-regrade-requests` | Lists the student's regrade requests and their status, explanation, response, and request time when available. |

All tools publish structured output and also include the same JSON as text content. Course, assignment, and submission IDs are validated as numeric strings. Course-scoped tools verify that the course appears under Student Courses before requesting course data; instructor, TA, unknown, and absent courses fail closed.

## Read-only guarantee

The MCP surface contains no submission, regrade-creation, extension, grading, roster, grade-export, debug-page, or other mutation tool. The Gradescope client exposes authenticated page GETs only. Its only outbound non-GET request is the required form POST to `/login`; same-origin URLs and redirects are enforced before cookies are attached, and redirects are bounded.

Authentication cookies are held in memory and are never written to the repository or disk. Never commit credentials, cookies, CSRF tokens, raw account pages, or student data.

## Authentication

Set the following environment variables:

- `GRADESCOPE_EMAIL`
- `GRADESCOPE_PASSWORD`

For HTTP deployment, place the service behind the intended external authentication layer (Cloudflare Access in the production design). Access JWT enforcement in the Node process is a later self-hosting milestone; do not expose the unauthenticated HTTP listener publicly.

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
MCP_TRANSPORT=http MCP_PORT=3100 npm start
```

The MCP endpoint is `POST /mcp`; `GET /healthz` returns a simple process-health response. The HTTP transport is stateless: each request receives a fresh MCP server/transport while the process-wide Gradescope client serializes authenticated page access and retains its in-memory session.

## Development status

The self-hosting refactor restores the upstream Node/Express shape while retaining only the student read-only core. Production container publishing, Cloudflare Access verification, Quadlet deployment, and live validation are separate milestones. The assignment parser still requires live validation and repair against the current student course-page markup.
