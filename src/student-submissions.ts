import { parseSubmissionList } from "./html-parser.js";
import type { GradescopeClient, GradescopeSubmission } from "./types.js";

/**
 * Gradescope's student course page links directly to the student's own
 * submission detail pages. The assignment-level submissions index is an
 * instructor-facing endpoint and is not authorized for normal students.
 */
export async function listOwnedStudentSubmissions(
  api: GradescopeClient,
  courseId: string,
  assignmentId: string
): Promise<GradescopeSubmission[]> {
  const html = await api.fetchPage(`/courses/${courseId}`);
  return parseSubmissionList(html, courseId, assignmentId);
}
