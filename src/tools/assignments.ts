import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseAssignmentList } from "../html-parser.js";
import { requireStudentCourse } from "../student-access.js";
import type { GradescopeClient } from "../types.js";
import { listAssignmentsOutputSchema } from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "../tool-utils.js";

const courseInput = {
  course_id: z
    .string()
    .regex(/^\d+$/, "course_id must be numeric")
    .describe(
      "Numeric Gradescope course ID as a string; normally obtain it from list-courses."
    ),
};

export function registerAssignmentTools(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "list-assignments",
    {
      description:
        "List assignments for a course, including IDs, due and late-due dates, submission status and time, lateness, scores, release state, and URLs. Use for questions about deadlines, missing or submitted work, or course grades, and to obtain an assignment_id for assignment-specific tools; use list-courses first if course_id is unknown. Use list-submissions for attempt history and get-submission for question or rubric details; null or unknown fields mean Gradescope did not expose the value reliably.",
      inputSchema: courseInput,
      outputSchema: listAssignmentsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const assignments = parseAssignmentList(
          await api.fetchPage(`/courses/${course_id}`),
          course_id
        );

        return toolSuccess({
          course_id,
          assignments: assignments.map((assignment) => ({
            assignment_id: assignment.id,
            assignment_name: assignment.name,
            assignment_type: assignment.type,
            due_date: assignment.dueDate,
            late_due_date: assignment.lateDueDate,
            submission_status: assignment.submissionStatus,
            status_raw: assignment.statusRaw,
            submitted: assignment.submitted,
            submitted_at: assignment.submittedAt,
            late: assignment.late,
            lateness: assignment.lateness,
            score: assignment.pointsAwarded,
            max_score: assignment.pointsPossible,
            released: assignment.released,
            url: assignment.url,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
