import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseSubmissionDetail, parseSubmissionList } from "../html-parser.js";
import { requireStudentCourse } from "../student-access.js";
import type { GradescopeClient, GradescopeSubmission } from "../types.js";
import {
  getSubmissionOutputSchema,
  listSubmissionsOutputSchema,
} from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "../tool-utils.js";

const numericId = (name: string) =>
  z.string().regex(/^\d+$/, `${name} must be numeric`);

const listInput = {
  course_id: numericId("course_id").describe("The Gradescope student course ID"),
  assignment_id: numericId("assignment_id").describe("The Gradescope assignment ID"),
};

const detailInput = {
  ...listInput,
  submission_id: numericId("submission_id").describe("The student submission ID"),
};

function submissionPath(courseId: string, assignmentId: string): string {
  return `/courses/${courseId}/assignments/${assignmentId}/submissions`;
}

function submissionOutput(submission: GradescopeSubmission) {
  return {
    submission_id: submission.id,
    submission_status: submission.submissionStatus,
    status_raw: submission.statusRaw,
    submitted: submission.submitted,
    submitted_at: submission.submittedAt,
    late: submission.late,
    lateness: submission.lateness,
    score: submission.score,
    max_score: submission.maxScore,
    url: submission.url,
  };
}

export function registerSubmissionTools(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "list-submissions",
    {
      description:
        "List the logged-in student's own submission attempts for an assignment, including timestamps, status, lateness, and scores.",
      inputSchema: listInput,
      outputSchema: listSubmissionsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const submissions = parseSubmissionList(
          await api.fetchPage(submissionPath(course_id, assignment_id))
        );
        return toolSuccess({
          course_id,
          assignment_id,
          submissions: submissions.map(submissionOutput),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get-submission",
    {
      description:
        "Get one of the logged-in student's submissions, including overall and per-question scores, rubric items, and grader comments.",
      inputSchema: detailInput,
      outputSchema: getSubmissionOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id, submission_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const summaries = parseSubmissionList(
          await api.fetchPage(submissionPath(course_id, assignment_id))
        );
        const summary = summaries.find((submission) => submission.id === submission_id);
        if (!summary) {
          throw new Error(
            `Submission ${submission_id} was not found among the student's submissions for assignment ${assignment_id}`
          );
        }

        const detail = parseSubmissionDetail(
          await api.fetchPage(
            `${submissionPath(course_id, assignment_id)}/${submission_id}`
          )
        );
        const merged = {
          ...summary,
          score: detail.score ?? summary.score,
          maxScore: detail.maxScore ?? summary.maxScore,
          submissionStatus:
            detail.submissionStatus === "unknown"
              ? summary.submissionStatus
              : detail.submissionStatus,
          statusRaw: detail.statusRaw ?? summary.statusRaw,
          submitted: detail.submitted ?? summary.submitted,
          submittedAt: detail.submittedAt ?? summary.submittedAt,
          late: detail.late ?? summary.late,
          lateness: detail.lateness ?? summary.lateness,
          questions: detail.questions,
        };

        return toolSuccess({
          course_id,
          assignment_id,
          submission: {
            ...submissionOutput(merged),
            questions: merged.questions.map((question) => ({
              name: question.name,
              score: question.score,
              max_score: question.maxScore,
              rubric_items: question.rubricItems.map((item) => ({
                description: item.description,
                points: item.points,
                applied: item.applied,
              })),
              comments: question.comments,
            })),
          },
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
