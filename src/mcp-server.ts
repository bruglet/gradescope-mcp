import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssignmentPdfTool } from "./tools/assignment-pdf.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerRegradeTools } from "./tools/regrade-requests.js";
import { registerSubmissionTools } from "./tools/submissions.js";
import type { GradescopeClient } from "./types.js";

/**
 * Create an isolated MCP server for one transport connection.
 *
 * The Gradescope client is shared by the process so its authenticated cookie
 * jar and request throttle survive individual stateless HTTP requests. The
 * server itself is intentionally per-connection because a
 * Streamable-HTTP stateless transport cannot be shared between requests.
 */
export function createServer(api: GradescopeClient): McpServer {
  const server = new McpServer({
    name: "gradescope-mcp",
    version: "1.0.0",
    icons: [
      {
        src: "https://raw.githubusercontent.com/bruglet/.github/main/assets/mcp/gradescope-mcp.png",
        mimeType: "image/png",
        sizes: ["256x256"],
      },
    ],
  });

  registerCourseTools(server, api);
  registerAssignmentTools(server, api);
  registerAssignmentPdfTool(server, api);
  registerSubmissionTools(server, api);
  registerRegradeTools(server, api);

  return server;
}
