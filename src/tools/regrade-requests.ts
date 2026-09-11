import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseRegradeRequests } from "../html-parser.js";
import { requireStudentCourse } from "../student-access.js";
import { listOwnedStudentSubmissions } from "../student-submissions.js";
import type { GradescopeClient, GradescopeRegradeRequest } from "../types.js";
import { listRegradeRequestsOutputSchema } from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "../tool-utils.js";

const inputSchema = {
  course_id: z
    .string()
    .regex(/^\d+$/, "course_id must be numeric")
    .describe(
      "Numeric Gradescope course ID as a string; normally obtain it from list-courses."
    ),
  assignment_id: z
    .string()
    .regex(/^\d+$/, "assignment_id must be numeric")
    .describe(
      "Numeric Gradescope assignment ID as a string; normally obtain it from list-assignments."
    ),
};

function requestOutput(request: GradescopeRegradeRequest) {
  return {
    regrade_id: request.id,
    question_name: request.questionName,
    regrade_status: request.status,
    regrade_status_raw: request.statusRaw,
    explanation: request.explanation,
    response: request.response,
    requested_at: request.createdAt,
    url: request.url,
  };
}

function mergeRequests(requests: GradescopeRegradeRequest[]): GradescopeRegradeRequest[] {
  const merged: GradescopeRegradeRequest[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const key =
      request.id ??
      request.url ??
      `${request.questionName ?? ""}|${request.createdAt ?? ""}|${request.explanation ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(request);
  }
  return merged;
}

async function requestsFromStudentSubmissions(
  api: GradescopeClient,
  courseId: string,
  assignmentId: string
): Promise<GradescopeRegradeRequest[]> {
  const submissions = await listOwnedStudentSubmissions(api, courseId, assignmentId);
  const requests: GradescopeRegradeRequest[] = [];
  for (const submission of submissions) {
    const detailHtml = await api.fetchPage(submission.url);
    requests.push(...parseRegradeRequests(detailHtml));
  }
  return requests;
}

export function registerRegradeTools(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "list-regrade-requests",
    {
      description:
        "List regrade requests for an assignment, including question, status, explanation, response, request time, and URL when available. Use when the user asks whether a regrade was requested, resolved, or answered; obtain course_id and assignment_id from list-courses and list-assignments. An empty result means no request was found, and this tool cannot create or modify regrade requests.",
      inputSchema,
      outputSchema: listRegradeRequestsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id }) => {
      try {
        await requireStudentCourse(api, course_id);

        let primaryError: unknown = null;
        let requests: GradescopeRegradeRequest[] = [];
        try {
          const html = await api.fetchPage(
            `/courses/${course_id}/assignments/${assignment_id}/regrade_requests`
          );
          requests = parseRegradeRequests(html);
        } catch (error) {
          primaryError = error;
        }

        if (requests.length === 0) {
          try {
            requests = await requestsFromStudentSubmissions(
              api,
              course_id,
              assignment_id
            );
          } catch (fallbackError) {
            if (primaryError) {
              throw new Error(
                `Unable to read student regrade requests: ${
                  primaryError instanceof Error ? primaryError.message : String(primaryError)
                }; fallback failed: ${
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                }`
              );
            }
            throw fallbackError;
          }
        }

        return toolSuccess({
          course_id,
          assignment_id,
          regrade_requests: mergeRequests(requests).map(requestOutput),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
