import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listOwnedStudentSubmissions } from "../student-submissions.js";
import { requireStudentCourse } from "../student-access.js";
import type { GradescopeClient } from "../types.js";
import { downloadSubmissionPdfOutputSchema } from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError } from "../tool-utils.js";

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
  submission_id: z
    .string()
    .regex(/^\d+$/, "submission_id must be numeric")
    .describe(
      "Numeric Gradescope submission ID as a string; normally obtain it from list-submissions."
    ),
};

function metadata(
  courseId: string,
  assignmentId: string,
  submissionId: string,
  available: boolean,
  filename: string | null,
  byteLength: number | null
) {
  return {
    course_id: courseId,
    assignment_id: assignmentId,
    submission_id: submissionId,
    available,
    filename,
    mime_type: available ? ("application/pdf" as const) : null,
    byte_length: byteLength,
  };
}

export function registerSubmissionPdfTool(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "download-submission-pdf",
    {
      description:
        "Retrieve the original PDF uploaded for one owned submission as an embedded resource with filename and size metadata. Use when the user asks to open or download their submitted work; obtain course_id and assignment_id from list-courses and list-assignments, and submission_id from list-submissions. This returns the file as submitted, without grading annotations, and never downloads the graded PDF export. Returns available=false when the submission does not expose an original PDF; use download-assignment-pdf for a provided worksheet or template.",
      inputSchema,
      outputSchema: downloadSubmissionPdfOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id, submission_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const submissions = await listOwnedStudentSubmissions(api, course_id, assignment_id);
        if (!submissions.some((submission) => submission.id === submission_id)) {
          throw new Error(
            `Submission ${submission_id} was not found among the student's submissions for assignment ${assignment_id}`
          );
        }
        const pdf = await api.fetchSubmissionPdf(course_id, assignment_id, submission_id);
        const result = metadata(
          course_id,
          assignment_id,
          submission_id,
          pdf !== null,
          pdf?.filename ?? null,
          pdf?.bytes.byteLength ?? null
        );

        const content: Array<
          | { type: "text"; text: string }
          | {
              type: "resource";
              resource: {
                uri: string;
                mimeType: "application/pdf";
                blob: string;
              };
            }
        > = [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ];

        if (pdf) {
          content.push({
            type: "resource",
            resource: {
              uri: `gradescope://courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}/original.pdf`,
              mimeType: "application/pdf",
              blob: Buffer.from(pdf.bytes).toString("base64"),
            },
          });
        }

        return {
          content,
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
