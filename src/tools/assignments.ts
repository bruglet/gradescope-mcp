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
    .describe("The Gradescope student course ID"),
};

export function registerAssignmentTools(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "list-assignments",
    {
      description:
        "List assignments from the student-facing course dashboard, including due dates, submission state, lateness, and scores when Gradescope exposes them.",
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
