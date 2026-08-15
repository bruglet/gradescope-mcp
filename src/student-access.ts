import { parseDashboard } from "./html-parser.js";
import type { GradescopeClient, GradescopeCourse } from "./types.js";

export async function listStudentCourses(
  api: GradescopeClient
): Promise<GradescopeCourse[]> {
  const courses = parseDashboard(await api.fetchPage("/account"));
  return courses.filter((course) => course.role === "student");
}

export async function requireStudentCourse(
  api: GradescopeClient,
  courseId: string
): Promise<GradescopeCourse> {
  const course = (await listStudentCourses(api)).find(
    (candidate) => candidate.id === courseId
  );

  if (!course) {
    throw new Error(
      `Course ${courseId} is not available under the logged-in account's Student Courses`
    );
  }

  return course;
}
