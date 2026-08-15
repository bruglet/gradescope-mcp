import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listStudentCourses } from "../student-access.js";
import type { GradescopeClient } from "../types.js";
import { listCoursesOutputSchema } from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "../tool-utils.js";

export function registerCourseTools(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "list-courses",
    {
      description:
        "List the courses available to the logged-in student, including course names, IDs, terms, and URLs.",
      inputSchema: {},
      outputSchema: listCoursesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const courses = await listStudentCourses(api);
        return toolSuccess({
          courses: courses.map((course) => ({
            course_id: course.id,
            course_name: course.name,
            short_name: course.shortName,
            term: course.term,
            url: course.url,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
