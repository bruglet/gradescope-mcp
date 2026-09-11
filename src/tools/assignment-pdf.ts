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
        "Retrieve the PDF supplied with an assignment, such as a worksheet or template, as an embedded resource with filename and size metadata. Use when the user asks to open, download, or check whether an assignment provides a PDF; this is the only Gradescope tool that determines file availability, and course_id and assignment_id normally come from list-courses and list-assignments. Do not use for submitted files or grading details; assignments without a provided PDF return available=false.",
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
