import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireStudentCourse } from "../student-access.js";
import type { GradescopeClient } from "../types.js";
import { downloadAssignmentPdfOutputSchema } from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError } from "../tool-utils.js";

const inputSchema = {
  course_id: z
    .string()
    .regex(/^\d+$/, "course_id must be numeric")
    .describe("The Gradescope student course ID"),
  assignment_id: z
    .string()
    .regex(/^\d+$/, "assignment_id must be numeric")
    .describe("The Gradescope assignment ID"),
};

function metadata(
  courseId: string,
  assignmentId: string,
  available: boolean,
  filename: string | null,
  byteLength: number | null
) {
  return {
    course_id: courseId,
    assignment_id: assignmentId,
    available,
    filename,
    mime_type: available ? ("application/pdf" as const) : null,
    byte_length: byteLength,
  };
}

export function registerAssignmentPdfTool(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "download-assignment-pdf",
    {
      description:
        "Download the provided PDF for a student assignment when Gradescope makes one available. The result includes an embedded PDF resource; assignments without a provided PDF return available=false.",
      inputSchema,
      outputSchema: downloadAssignmentPdfOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const pdf = await api.fetchAssignmentPdf(course_id, assignment_id);
        const result = metadata(
          course_id,
          assignment_id,
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
              uri: `gradescope://courses/${course_id}/assignments/${assignment_id}/provided.pdf`,
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
