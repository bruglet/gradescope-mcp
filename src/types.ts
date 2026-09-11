export type NormalizedSubmissionStatus =
  | "submitted"
  | "graded"
  | "unsubmitted"
  | "unknown";

export type NormalizedRegradeStatus =
  | "pending"
  | "approved"
  | "denied"
  | "resolved"
  | "unknown";

export interface GradescopeCourse {
  id: string;
  name: string;
  shortName: string;
  term: string | null;
  role: "student" | "instructor" | "ta" | "unknown";
  url: string;
}

export interface GradescopeAssignment {
  id: string;
  name: string;
  type: string;
  dueDate: string | null;
  lateDueDate: string | null;
  released: boolean;
  submissionStatus: NormalizedSubmissionStatus;
  statusRaw: string | null;
  submitted: boolean | null;
  submittedAt: string | null;
  late: boolean | null;
  lateness: string | null;
  pointsPossible: number | null;
  pointsAwarded: number | null;
  url: string;
}

export interface GradescopeQuestionOutline {
  name: string;
  maxScore: number | null;
}

export interface GradescopeSubmission {
  id: string;
  score: number | null;
  maxScore: number | null;
  submissionStatus: NormalizedSubmissionStatus;
  statusRaw: string | null;
  submitted: boolean | null;
  submittedAt: string | null;
  late: boolean | null;
  lateness: string | null;
  url: string;
}

export interface GradescopeSubmissionDetail extends GradescopeSubmission {
  questions: GradescopeQuestionResult[];
}

export interface GradescopeQuestionResult {
  name: string;
  score: number | null;
  maxScore: number | null;
  rubricItems: GradescopeRubricItem[];
  comments: string[];
}

export interface GradescopeRubricItem {
  description: string;
  points: number;
  applied: boolean;
}

export interface GradescopeRegradeRequest {
  id: string | null;
  questionName: string | null;
  status: NormalizedRegradeStatus;
  statusRaw: string | null;
  explanation: string | null;
  response: string | null;
  createdAt: string | null;
  url: string | null;
}

export interface GradescopeProvidedPdf {
  filename: string;
  mimeType: "application/pdf";
  bytes: Uint8Array;
}

export interface GradescopeClient {
  fetchPage(urlPath: string): Promise<string>;
  fetchAssignmentPdf(
    courseId: string,
    assignmentId: string
  ): Promise<GradescopeProvidedPdf | null>;
}
