import { z } from "zod";

export const normalizedSubmissionStatusSchema = z.enum([
  "submitted",
  "graded",
  "unsubmitted",
  "unknown",
]);

export const normalizedRegradeStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "resolved",
  "unknown",
]);

export const deadlineStatusSchema = z.enum([
  "before_due",
  "accepting_late",
  "closed",
  "unknown",
]);

const courseSchema = z.object({
  course_id: z.string(),
  course_name: z.string(),
  short_name: z.string(),
  term: z.string().nullable(),
  url: z.string(),
});

const assignmentSchema = z.object({
  assignment_id: z.string(),
  assignment_name: z.string(),
  assignment_type: z.string(),
  due_date: z.string().nullable(),
  late_due_date: z.string().nullable(),
  deadline_status: deadlineStatusSchema.describe(
    "Current deadline phase from Gradescope labels and complete due timestamps; unknown when it cannot be determined."
  ),
  submission_status: normalizedSubmissionStatusSchema,
  status_raw: z.string().nullable(),
  submitted: z.boolean().nullable(),
  submitted_at: z.string().nullable(),
  late: z.boolean().nullable(),
  lateness: z.string().nullable(),
  score: z.number().nullable(),
  max_score: z.number().nullable(),
  released: z.boolean(),
  url: z.string(),
});

const submissionSummarySchema = z.object({
  submission_id: z.string(),
  submission_status: normalizedSubmissionStatusSchema,
  status_raw: z.string().nullable(),
  submitted: z.boolean().nullable(),
  submitted_at: z.string().nullable(),
  late: z.boolean().nullable(),
  lateness: z.string().nullable(),
  score: z.number().nullable(),
  max_score: z.number().nullable(),
  url: z.string(),
});

const rubricItemSchema = z.object({
  description: z.string(),
  points: z.number().nullable().describe(
    "Signed category points: positive awards credit, negative deducts credit; null when the scoring direction is unavailable."
  ),
  applied: z.boolean().describe("Whether Gradescope explicitly marks this category as applied to this question."),
});

const questionResultSchema = z.object({
  name: z.string(),
  score: z.number().nullable(),
  max_score: z.number().nullable(),
  scoring_type: z.enum(["positive", "negative"]).nullable().describe(
    "Positive rubrics start at zero; negative rubrics start at full credit. Null means Gradescope did not expose the mode."
  ),
  rubric_items: z.array(rubricItemSchema),
  score_adjustments: z.array(z.object({
    points: z.number().describe("Additional signed score adjustment, independent of the rubric scoring mode."),
    comment: z.string().nullable(),
  })),
  comments: z.array(z.string()),
});

const regradeRequestSchema = z.object({
  regrade_id: z.string().nullable(),
  question_name: z.string().nullable(),
  regrade_status: normalizedRegradeStatusSchema,
  regrade_status_raw: z.string().nullable(),
  explanation: z.string().nullable(),
  response: z.string().nullable(),
  requested_at: z.string().nullable(),
  url: z.string().nullable(),
});

export const listCoursesOutputSchema = z.object({
  courses: z.array(courseSchema),
});

export const listAssignmentsOutputSchema = z.object({
  course_id: z.string(),
  assignments: z.array(assignmentSchema),
});

export const listSubmissionsOutputSchema = z.object({
  course_id: z.string(),
  assignment_id: z.string(),
  submissions: z.array(submissionSummarySchema),
});

export const getSubmissionOutputSchema = z.object({
  course_id: z.string(),
  assignment_id: z.string(),
  submission: submissionSummarySchema.extend({
    questions: z.array(questionResultSchema),
  }),
});

export const listRegradeRequestsOutputSchema = z.object({
  course_id: z.string(),
  assignment_id: z.string(),
  regrade_requests: z.array(regradeRequestSchema),
});

export const downloadAssignmentPdfOutputSchema = z.object({
  course_id: z.string(),
  assignment_id: z.string(),
  available: z.boolean(),
  filename: z.string().nullable(),
  mime_type: z.literal("application/pdf").nullable(),
  byte_length: z.number().int().nonnegative().nullable(),
});

export const downloadSubmissionPdfOutputSchema = downloadAssignmentPdfOutputSchema.extend({
  submission_id: z.string(),
});
