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
  points: z.number(),
  applied: z.boolean(),
});

const questionResultSchema = z.object({
  name: z.string(),
  score: z.number().nullable(),
  max_score: z.number().nullable(),
  rubric_items: z.array(rubricItemSchema),
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
