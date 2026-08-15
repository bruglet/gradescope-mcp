import { parse as parseHTML, type HTMLElement } from "node-html-parser";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseSubmissionDetail } from "./html-parser.js";
import { requireStudentCourse } from "./student-access.js";
import { listOwnedStudentSubmissions } from "./student-submissions.js";
import type { GradescopeClient } from "./types.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "./tool-utils.js";

/**
 * Temporary B2 diagnostic surface. Keep all of this in one module so it can
 * be removed with one import and one registration call after the live detail
 * page has been repaired.
 */

const MAX_DETAILS = 32;
const MAX_CLASSES = 24;
const MAX_TEXT_LENGTH = 160;
const GRADESCOPE_ORIGIN = "https://www.gradescope.com";

const boundedStringListSchema = z.object({
  items: z.array(z.string()),
  total_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const questionGroupSchema = z.object({
  index: z.number().int().nonnegative(),
  tag: z.string(),
  classes: z.array(z.string()),
  heading: z.string().nullable(),
  text_length: z.number().int().nonnegative(),
  descendant_count: z.number().int().nonnegative(),
  score_marker_count: z.number().int().nonnegative(),
  score_pair_text_count: z.number().int().nonnegative(),
  rubric_marker_count: z.number().int().nonnegative(),
  comment_marker_count: z.number().int().nonnegative(),
});

const questionScoreSchema = z.object({
  name: z.string(),
  score: z.number().nullable(),
  max_score: z.number().nullable(),
  rubric_item_count: z.number().int().nonnegative(),
  comment_count: z.number().int().nonnegative(),
});

export const diagnoseSubmissionOutputSchema = z.object({
  course_id: z.string(),
  assignment_id: z.string(),
  submission_id: z.string(),
  fetched_path: z.string(),
  page: z.object({
    title: z.string().nullable(),
    utf8_bytes: z.number().int().nonnegative(),
    login_page: z.object({
      detected: z.boolean(),
      form_count: z.number().int().nonnegative(),
      login_form_count: z.number().int().nonnegative(),
      email_input_count: z.number().int().nonnegative(),
      password_input_count: z.number().int().nonnegative(),
      csrf_field_present: z.boolean(),
    }),
    scripts: z.object({
      total_count: z.number().int().nonnegative(),
      external_count: z.number().int().nonnegative(),
      inline_count: z.number().int().nonnegative(),
      json_count: z.number().int().nonnegative(),
      question_marker_script_count: z.number().int().nonnegative(),
      rubric_marker_script_count: z.number().int().nonnegative(),
    }),
  }),
  parser: z.object({
    current_question_count: z.number().int().nonnegative(),
    current_question_names: boundedStringListSchema,
    current_question_scores: z.object({
      items: z.array(questionScoreSchema),
      total_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    summary: z.object({
      score: z.number().nullable(),
      max_score: z.number().nullable(),
      submission_status: z.string(),
      submitted: z.boolean().nullable(),
      submitted_at_present: z.boolean(),
      late: z.boolean().nullable(),
      lateness_present: z.boolean(),
    }),
    error: z.string().nullable(),
  }),
  discovery: z.object({
    selectors: z.object({
      question: z.number().int().nonnegative(),
      question_id: z.number().int().nonnegative(),
      rubric_question: z.number().int().nonnegative(),
      question_group: z.number().int().nonnegative(),
      question_group_like: z.number().int().nonnegative(),
      submission_question_like: z.number().int().nonnegative(),
      score_class: z.number().int().nonnegative(),
      weight_and_score: z.number().int().nonnegative(),
      score_pair_text: z.number().int().nonnegative(),
      rubric_item: z.number().int().nonnegative(),
      rubric_like: z.number().int().nonnegative(),
      comment_like: z.number().int().nonnegative(),
      annotation: z.number().int().nonnegative(),
      datetime: z.number().int().nonnegative(),
    }),
    headings: boundedStringListSchema,
    question_group_classes: boundedStringListSchema,
    question_groups: z.object({
      items: z.array(questionGroupSchema),
      total_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  }),
  warnings: z.array(z.string()),
});

type Bounded<T> = {
  items: T[];
  total_count: number;
  truncated: boolean;
};

function bounded<T>(items: T[]): Bounded<T> {
  return {
    items: items.slice(0, MAX_DETAILS),
    total_count: items.length,
    truncated: items.length > MAX_DETAILS,
  };
}

function safeIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 80 || /^[A-Za-z0-9]{24,}$/.test(trimmed)) {
    return "[redacted]";
  }
  return trimmed.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function safeText(value: string | null | undefined): string | null {
  if (!value) return null;

  let sanitized = value.replace(/\s+/g, " ").trim();
  if (!sanitized) return null;

  sanitized = sanitized
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted-token]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-token]");

  if (sanitized.length > MAX_TEXT_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
  }
  return sanitized;
}

function visibleText(element: HTMLElement | null): string | null {
  if (!element) return null;

  const excludedTags = new Set([
    "input",
    "script",
    "style",
    "template",
    "textarea",
    "select",
  ]);

  function visit(node: HTMLElement): string {
    if (excludedTags.has(node.tagName.toLowerCase())) return "";
    if (node.childNodes.length === 0) return node.textContent ?? "";

    return node.childNodes
      .map((child) => {
        const childElement = child as HTMLElement;
        if (typeof childElement.tagName === "string") {
          return visit(childElement);
        }
        return child.textContent ?? "";
      })
      .join(" ");
  }

  return safeText(visit(element));
}

function classNames(element: HTMLElement): string[] {
  return Array.from(
    new Set(
      (element.getAttribute("class") ?? "")
        .split(/\s+/)
        .map((value) => safeIdentifier(value))
        .filter((value): value is string => value !== null)
    )
  ).slice(0, MAX_CLASSES);
}

function loginDiagnostics(root: HTMLElement) {
  const forms = root.querySelectorAll("form");
  const loginForms = forms.filter((form) => {
    const action = form.getAttribute("action") ?? "";
    return (
      /(?:^|\/)login(?:$|[?#])/.test(action) ||
      Boolean(form.querySelector('input[name="session[email]"]')) ||
      Boolean(form.querySelector('input[name="session[password]"]'))
    );
  });

  const emailInputs = root.querySelectorAll(
    'input[name="session[email]"], input[type="email"]'
  );
  const passwordInputs = root.querySelectorAll(
    'input[name="session[password]"], input[type="password"]'
  );

  return {
    detected:
      loginForms.length > 0 ||
      (emailInputs.length > 0 && passwordInputs.length > 0),
    form_count: forms.length,
    login_form_count: loginForms.length,
    email_input_count: emailInputs.length,
    password_input_count: passwordInputs.length,
    csrf_field_present: Boolean(
      root.querySelector(
        'input[name="authenticity_token"], meta[name="csrf-token"]'
      )
    ),
  };
}

function scriptDiagnostics(root: HTMLElement) {
  const scripts = root.querySelectorAll("script");
  const questionMarker = /question|submissionoutlinequestion|question-group/i;
  const rubricMarker = /rubric|regrade/i;

  return {
    total_count: scripts.length,
    external_count: scripts.filter((script) => Boolean(script.getAttribute("src"))).length,
    inline_count: scripts.filter((script) => !script.getAttribute("src")).length,
    json_count: scripts.filter((script) => /json/i.test(script.getAttribute("type") ?? "")).length,
    question_marker_script_count: scripts.filter((script) => questionMarker.test(script.textContent ?? "")).length,
    rubric_marker_script_count: scripts.filter((script) => rubricMarker.test(script.textContent ?? "")).length,
  };
}

function selectorDiagnostics(root: HTMLElement) {
  const scorePairPattern = /\b-?\d+(?:\.\d+)?\s*\/\s*-?\d+(?:\.\d+)?\b/;
  const textElements = root.querySelectorAll("td, th, span, div, p, li, h1, h2, h3, h4");

  return {
    question: root.querySelectorAll(".question").length,
    question_id: root.querySelectorAll("[data-question-id]").length,
    rubric_question: root.querySelectorAll(".rubric-question").length,
    question_group: root.querySelectorAll(".question-group").length,
    question_group_like: root.querySelectorAll("[class*='question-group']").length,
    submission_question_like: root.querySelectorAll("[class*='submissionOutlineQuestion']").length,
    score_class: root.querySelectorAll("[class*='score']").length,
    weight_and_score: root.querySelectorAll("[class*='weightAndScore']").length,
    score_pair_text: textElements.filter((element) => scorePairPattern.test(visibleText(element) ?? "")).length,
    rubric_item: root.querySelectorAll(".rubricItem").length,
    rubric_like: root.querySelectorAll("[class*='rubric']").length,
    comment_like: root.querySelectorAll("[class*='comment']").length,
    annotation: root.querySelectorAll(".annotation").length,
    datetime: root.querySelectorAll("time[datetime]").length,
  };
}

function questionGroups(root: HTMLElement) {
  const exactGroups = root.querySelectorAll(".question-group");
  const groups = exactGroups.length > 0
    ? exactGroups
    : root.querySelectorAll("[class*='question-group']");
  const scorePairPattern = /\b-?\d+(?:\.\d+)?\s*\/\s*-?\d+(?:\.\d+)?\b/;

  return groups.map((group, index) => {
    const descendants = group.querySelectorAll("*");
    const groupText = visibleText(group) ?? "";
    const heading = group.querySelector(
      ".submissionOutline--sectionHeading, .submissionOutlineQuestion--sectionHeading, h1, h2, h3, h4"
    );
    const scoreElements = group.querySelectorAll("[class*='score'], [class*='points'], [class*='weightAndScore']");
    const scorePairTextCount = group
      .querySelectorAll("td, th, span, div, p, li, h1, h2, h3, h4")
      .filter((element) => scorePairPattern.test(visibleText(element) ?? "")).length;

    return {
      index,
      tag: group.tagName.toLowerCase(),
      classes: classNames(group),
      heading: visibleText(heading),
      text_length: groupText.length,
      descendant_count: descendants.length,
      score_marker_count: scoreElements.length,
      score_pair_text_count: scorePairTextCount,
      rubric_marker_count: group.querySelectorAll("[class*='rubric'], .rubricItem").length,
      comment_marker_count: group.querySelectorAll("[class*='comment'], .comment, .annotation").length,
    };
  });
}

function uniqueClassNames(root: HTMLElement): string[] {
  return Array.from(
    new Set(root.querySelectorAll("[class]").flatMap((element) => classNames(element)))
  ).sort();
}

function diagnosticWarnings(
  login: ReturnType<typeof loginDiagnostics>,
  selectors: ReturnType<typeof selectorDiagnostics>,
  scripts: ReturnType<typeof scriptDiagnostics>,
  questionCount: number,
  parserError: string | null
): string[] {
  const warnings: string[] = [];
  const questionMarkupCount =
    selectors.question +
    selectors.question_id +
    selectors.rubric_question +
    selectors.question_group +
    selectors.submission_question_like;

  if (login.detected) {
    warnings.push(
      "authentication-page: the fetched submission page looks like a Gradescope login page"
    );
  }
  if (parserError) {
    warnings.push(
      "parser-error: the current submission detail parser threw while inspecting this page"
    );
  }
  if (!login.detected && questionCount === 0 && questionMarkupCount > 0) {
    warnings.push(
      "selector-mismatch: question-like markup was found, but the current parser recognized zero question results"
    );
  }
  if (!login.detected && questionCount === 0 && questionMarkupCount === 0 && scripts.question_marker_script_count > 0) {
    warnings.push(
      "rendered-or-embedded-data-possible: question markers were found only in script content; the browser may render question data after the raw HTML response"
    );
  }
  if (!login.detected && questionCount === 0 && questionMarkupCount === 0 && scripts.question_marker_script_count === 0) {
    warnings.push(
      "question-markup-absent: no recognized question elements or question markers were found in the fetched HTML"
    );
  }
  if (!login.detected && questionCount > 0 && selectors.rubric_like === 0) {
    warnings.push(
      "rubric-markup-absent: question results were found, but no rubric markers were present in the fetched HTML"
    );
  }

  return warnings;
}

export function diagnoseSubmissionPage(
  html: string,
  courseId: string,
  assignmentId: string,
  submissionId: string,
  fetchedPath: string
) {
  const root = parseHTML(html);
  const login = loginDiagnostics(root);
  const scripts = scriptDiagnostics(root);
  const selectors = selectorDiagnostics(root);
  const groups = questionGroups(root);

  let detail: ReturnType<typeof parseSubmissionDetail> | null = null;
  let parserError: string | null = null;
  try {
    detail = parseSubmissionDetail(html);
  } catch (error) {
    parserError = safeText(error instanceof Error ? error.message : String(error));
  }

  const questionScores = detail?.questions.map((question) => ({
    name: safeText(question.name) ?? "[redacted]",
    score: question.score,
    max_score: question.maxScore,
    rubric_item_count: question.rubricItems.length,
    comment_count: question.comments.length,
  })) ?? [];

  return {
    course_id: courseId,
    assignment_id: assignmentId,
    submission_id: submissionId,
    fetched_path: fetchedPath,
    page: {
      title: safeText(visibleText(root.querySelector("title"))),
      utf8_bytes: new TextEncoder().encode(html).byteLength,
      login_page: login,
      scripts,
    },
    parser: {
      current_question_count: detail?.questions.length ?? 0,
      current_question_names: bounded(
        detail?.questions.map((question) => safeText(question.name) ?? "[redacted]") ?? []
      ),
      current_question_scores: bounded(questionScores),
      summary: {
        score: detail?.score ?? null,
        max_score: detail?.maxScore ?? null,
        submission_status: detail?.submissionStatus ?? "unknown",
        submitted: detail?.submitted ?? null,
        submitted_at_present: Boolean(detail?.submittedAt),
        late: detail?.late ?? null,
        lateness_present: Boolean(detail?.lateness),
      },
      error: parserError,
    },
    discovery: {
      selectors,
      headings: bounded(
        root
          .querySelectorAll("h1, h2, h3, h4")
          .map((heading) => visibleText(heading))
          .filter((value): value is string => value !== null)
      ),
      question_group_classes: bounded(
        Array.from(new Set(groups.flatMap((group) => group.classes)))
      ),
      question_groups: bounded(groups),
    },
    warnings: diagnosticWarnings(
      login,
      selectors,
      scripts,
      detail?.questions.length ?? 0,
      parserError
    ),
  };
}

const inputSchema = {
  course_id: z
    .string()
    .regex(/^\d+$/, "course_id must be numeric")
    .describe("The Gradescope student course ID"),
  assignment_id: z
    .string()
    .regex(/^\d+$/, "assignment_id must be numeric")
    .describe("The Gradescope assignment ID"),
  submission_id: z
    .string()
    .regex(/^\d+$/, "submission_id must be numeric")
    .describe("The student's Gradescope submission ID"),
};

export function registerSubmissionDiagnosticTool(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "diagnose-submission",
    {
      description:
        "Temporary B2 diagnostic: inspect the fetched student submission detail page for question, score, rubric, script, and rendering markers. This tool will be removed after the permanent detail parser repair.",
      inputSchema,
      outputSchema: diagnoseSubmissionOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id, submission_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const submissions = await listOwnedStudentSubmissions(
          api,
          course_id,
          assignment_id
        );
        const submission = submissions.find((candidate) => candidate.id === submission_id);
        if (!submission) {
          throw new Error(
            `Submission ${submission_id} was not found among the student's submissions for assignment ${assignment_id}`
          );
        }

        const html = await api.fetchPage(submission.url);
        return toolSuccess(
          diagnoseSubmissionPage(
            html,
            course_id,
            assignment_id,
            submission_id,
            submission.url
          )
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
