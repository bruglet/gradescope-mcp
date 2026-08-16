import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseSubmissionDetail } from "../html-parser.js";
import { requireStudentCourse } from "../student-access.js";
import { listOwnedStudentSubmissions } from "../student-submissions.js";
import type { GradescopeClient, GradescopeSubmission } from "../types.js";
import {
  getSubmissionOutputSchema,
  listSubmissionsOutputSchema,
} from "../tool-schemas.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "../tool-utils.js";

const numericId = (name: string) =>
  z.string().regex(/^\d+$/, `${name} must be numeric`);

const listInput = {
  course_id: numericId("course_id").describe(
    "Numeric Gradescope course ID as a string; normally obtain it from list-courses."
  ),
  assignment_id: numericId("assignment_id").describe(
    "Numeric Gradescope assignment ID as a string; normally obtain it from list-assignments."
  ),
};

const detailInput = {
  ...listInput,
  submission_id: numericId("submission_id").describe(
    "Numeric Gradescope submission ID as a string; normally obtain it from list-submissions."
  ),
};

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
        "List submission attempts for an assignment, including submission IDs, timestamps, status, lateness, scores, and URLs. Use when the user asks about attempt history or when you need a submission_id for get-submission; obtain course_id and assignment_id from list-courses and list-assignments. This returns attempt summaries, not per-question scores, rubric items, or grader comments.",
      inputSchema: listInput,
      outputSchema: listSubmissionsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const submissions = await listOwnedStudentSubmissions(
          api,
          course_id,
          assignment_id
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
        "Get one specific submission with its summary, per-question scores, rubric items, and grader comments. Use for detailed grading questions after list-submissions provides submission_id; do not use for assignment overviews or attempt history. Question, rubric, or comment arrays may be empty when Gradescope has not released or does not expose those details.",
      inputSchema: detailInput,
      outputSchema: getSubmissionOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id, submission_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const summaries = await listOwnedStudentSubmissions(
          api,
          course_id,
          assignment_id
        );
        const summary = summaries.find((submission) => submission.id === submission_id);
        if (!summary) {
          throw new Error(
            `Submission ${submission_id} was not found among the student's submissions for assignment ${assignment_id}`
          );
        }

        const detail = parseSubmissionDetail(
          await api.fetchPage(summary.url)
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
