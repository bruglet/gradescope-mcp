import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerRegradeTools } from "./tools/regrade-requests.js";
import { registerSubmissionTools } from "./tools/submissions.js";
import { registerCourseDiagnosticTool } from "./temporary-course-diagnostics.js";
import { registerSubmissionDiagnosticTool } from "./temporary-submission-diagnostics.js";
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
  });

  registerCourseTools(server, api);
  registerAssignmentTools(server, api);
  registerSubmissionTools(server, api);
  registerRegradeTools(server, api);
  registerCourseDiagnosticTool(server, api);
  registerSubmissionDiagnosticTool(server, api);

  return server;
}
