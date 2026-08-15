import { parse as parseHTML, type HTMLElement } from "node-html-parser";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseAssignmentList } from "./html-parser.js";
import { requireStudentCourse } from "./student-access.js";
import type { GradescopeClient } from "./types.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "./tool-utils.js";

/**
 * Temporary B1 diagnostic surface. Keep all of this in one module so it can
 * be deleted, along with its one registration call, after the live parser
 * repair is complete.
 */

const MAX_DETAILS = 32;
const MAX_ANCESTORS = 4;
const MAX_TEXT_LENGTH = 160;
const GRADESCOPE_ORIGIN = "https://www.gradescope.com";

const boundedStringListSchema = z.object({
  items: z.array(z.string()),
  total_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const ancestorSchema = z.object({
  tag: z.string(),
  id: z.string().nullable(),
  classes: z.array(z.string()),
});

const assignmentLinkSchema = z.object({
  assignment_id: z.string(),
  label: z.string().nullable(),
  path: z.string(),
  classes: z.array(z.string()),
  ancestors: z.array(ancestorSchema),
});

const tableDiagnosticSchema = z.object({
  heading_labels: boundedStringListSchema,
  row_count: z.number().int().nonnegative(),
  row_class_names: boundedStringListSchema,
});

export const diagnoseCourseOutputSchema = z.object({
  course_id: z.string(),
  course_name: z.string(),
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
  }),
  parser: z.object({
    current_assignment_count: z.number().int().nonnegative(),
    current_assignment_ids: boundedStringListSchema,
    tr_count: z.number().int().nonnegative(),
    assignment_row_count: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }),
  discovery: z.object({
    generic_assignment_link_count: z.number().int().nonnegative(),
    unique_assignment_count: z.number().int().nonnegative(),
    links: z.object({
      items: z.array(assignmentLinkSchema),
      total_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  }),
  structure: z.object({
    tables: z.object({
      items: z.array(tableDiagnosticSchema),
      total_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    row_class_names: boundedStringListSchema,
    card_count: z.number().int().nonnegative(),
    card_class_names: boundedStringListSchema,
    presence: z.object({
      time_datetime_count: z.number().int().nonnegative(),
      status_element_count: z.number().int().nonnegative(),
      score_element_count: z.number().int().nonnegative(),
      due_date_element_count: z.number().int().nonnegative(),
      late_date_element_count: z.number().int().nonnegative(),
      status_text_count: z.number().int().nonnegative(),
      score_text_count: z.number().int().nonnegative(),
      due_date_text_count: z.number().int().nonnegative(),
      late_text_count: z.number().int().nonnegative(),
    }),
  }),
  warnings: z.array(z.string()),
});

type Bounded<T> = {
  items: T[];
  total_count: number;
  truncated: boolean;
};

type AssignmentLinkDiagnostic = {
  assignment_id: string;
  label: string | null;
  path: string;
  classes: string[];
  ancestors: Array<{
    tag: string;
    id: string | null;
    classes: string[];
  }>;
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
  ).slice(0, 16);
}

function ancestors(element: HTMLElement): AssignmentLinkDiagnostic["ancestors"] {
  const result: AssignmentLinkDiagnostic["ancestors"] = [];
  let current: HTMLElement | null = element;

  while (current && result.length < MAX_ANCESTORS) {
    result.push({
      tag: current.tagName.toLowerCase(),
      id: safeIdentifier(current.getAttribute("id")),
      classes: classNames(current),
    });

    const parent = current.parentNode as HTMLElement | null;
    current = parent && typeof parent.tagName === "string" ? parent : null;
  }

  return result;
}

function sameOriginAssignmentPath(
  href: string | null | undefined,
  courseId: string
): { assignmentId: string; path: string } | null {
  if (!href) return null;

  try {
    const url = new URL(href, `${GRADESCOPE_ORIGIN}/`);
    if (url.origin !== GRADESCOPE_ORIGIN) return null;

    const match = url.pathname.match(
      new RegExp(`^/courses/${courseId}/assignments/(\\d+)/?$`)
    );
    if (!match) return null;

    return { assignmentId: match[1], path: url.pathname };
  } catch {
    return null;
  }
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

function tableDiagnostics(root: HTMLElement) {
  return root.querySelectorAll("table").map((table) => {
    const headerRow =
      table.querySelector("thead tr") ?? table.querySelector("tr");
    const headings = headerRow
      ? headerRow
          .querySelectorAll("th, td")
          .map((cell) => visibleText(cell))
          .filter((value): value is string => value !== null)
      : [];
    const rows = table.querySelectorAll("tr");
    const rowClassNames = Array.from(
      new Set(rows.flatMap((row) => classNames(row)))
    );

    return {
      heading_labels: bounded(headings),
      row_count: Math.max(0, rows.length - (headerRow ? 1 : 0)),
      row_class_names: bounded(rowClassNames),
    };
  });
}

function classStructure(root: HTMLElement) {
  const classElements = root.querySelectorAll("[class]");
  const rows = root.querySelectorAll("tr");
  const rowClassNames = Array.from(
    new Set(rows.flatMap((row) => classNames(row)))
  );
  const cardElements = classElements.filter((element) =>
    classNames(element).some((name) => /assignment|card|tile|item/i.test(name))
  );
  const cardClassNames = Array.from(
    new Set(cardElements.flatMap((element) => classNames(element)))
  );

  const statusTextPattern =
    /\b(submitted|turned in|graded|missing|unsubmitted|not submitted|late|on time)\b/i;
  const scoreTextPattern = /\b-?\d+(?:\.\d+)?\s*\/\s*-?\d+(?:\.\d+)?\b/;
  const dueTextPattern = /\b(due|deadline)\b/i;
  const lateTextPattern = /\b(late|overdue)\b/i;
  const textElements = root.querySelectorAll("td, th, span, div, p, li, time");

  let statusElementCount = 0;
  let scoreElementCount = 0;
  let dueDateElementCount = 0;
  let lateDateElementCount = 0;
  for (const element of classElements) {
    const names = classNames(element).join(" ");
    if (/status|submission/i.test(names)) statusElementCount += 1;
    if (/score|grade|points/i.test(names)) scoreElementCount += 1;
    if (/due|deadline/i.test(names)) dueDateElementCount += 1;
    if (/late/i.test(names)) lateDateElementCount += 1;
  }

  let statusTextCount = 0;
  let scoreTextCount = 0;
  let dueDateTextCount = 0;
  let lateTextCount = 0;
  for (const element of textElements) {
    const text = visibleText(element) ?? "";
    if (statusTextPattern.test(text)) statusTextCount += 1;
    if (scoreTextPattern.test(text)) scoreTextCount += 1;
    if (dueTextPattern.test(text)) dueDateTextCount += 1;
    if (lateTextPattern.test(text)) lateTextCount += 1;
  }

  return {
    row_class_names: bounded(rowClassNames),
    card_count: cardElements.length,
    card_class_names: bounded(cardClassNames),
    presence: {
      time_datetime_count: root.querySelectorAll("time[datetime]").length,
      status_element_count: statusElementCount,
      score_element_count: scoreElementCount,
      due_date_element_count: dueDateElementCount,
      late_date_element_count: lateDateElementCount,
      status_text_count: statusTextCount,
      score_text_count: scoreTextCount,
      due_date_text_count: dueDateTextCount,
      late_text_count: lateTextCount,
    },
  };
}

function genericAssignmentLinks(
  root: HTMLElement,
  courseId: string
): AssignmentLinkDiagnostic[] {
  const links: AssignmentLinkDiagnostic[] = [];
  for (const link of root.querySelectorAll("a[href]")) {
    const location = sameOriginAssignmentPath(
      link.getAttribute("href"),
      courseId
    );
    if (!location) continue;

    links.push({
      assignment_id: location.assignmentId,
      label: visibleText(link),
      path: location.path,
      classes: classNames(link),
      ancestors: ancestors(link),
    });
  }
  return links;
}

function hasCoursePageStructure(root: HTMLElement): boolean {
  if (root.querySelector("#course-show, .course-show, table.assignments")) {
    return true;
  }

  const title = visibleText(root.querySelector("title")) ?? "";
  const headings = root
    .querySelectorAll("h1, h2, h3")
    .map((heading) => visibleText(heading) ?? "");
  return /course|gradescope/i.test(title) && headings.length > 0;
}

function diagnosticWarnings(
  login: ReturnType<typeof loginDiagnostics>,
  currentAssignmentCount: number,
  genericLinks: AssignmentLinkDiagnostic[],
  coursePageStructure: boolean,
  parserError: string | null
): string[] {
  const warnings: string[] = [];

  if (login.detected) {
    warnings.push(
      "authentication-page: the fetched course page looks like a Gradescope login page"
    );
  }
  if (parserError) {
    warnings.push(
      "parser-error: the current assignment parser threw while inspecting this page"
    );
  }

  if (!login.detected && genericLinks.length > 0 && currentAssignmentCount === 0) {
    warnings.push(
      "selector-mismatch: generic assignment links were found, but the current assignment parser recognized zero assignments"
    );
  } else if (
    !login.detected &&
    genericLinks.length > currentAssignmentCount
  ) {
    warnings.push(
      "partial-selector-match: generic assignment links outnumber assignments recognized by the current parser"
    );
  } else if (!login.detected && genericLinks.length === 0 && currentAssignmentCount === 0) {
    if (coursePageStructure) {
      warnings.push(
        "valid-empty-course-possible: course-page structure was detected, but no assignment links were found; this may be a genuinely empty course"
      );
    } else {
      warnings.push(
        "unexpected-markup: no assignment links or recognizable course-page structure were found"
      );
    }
  }

  return warnings;
}

export function diagnoseCoursePage(
  html: string,
  courseId: string,
  courseName: string
) {
  const root = parseHTML(html);
  const login = loginDiagnostics(root);
  const title = visibleText(root.querySelector("title"));
  const links = genericAssignmentLinks(root, courseId);

  let assignments = [] as ReturnType<typeof parseAssignmentList>;
  let parserError: string | null = null;
  try {
    assignments = parseAssignmentList(html);
  } catch (error) {
    parserError = safeText(error instanceof Error ? error.message : String(error));
  }

  const uniqueAssignmentIds = Array.from(
    new Set(links.map((link) => link.assignment_id))
  );
  const structure = classStructure(root);
  const warnings = diagnosticWarnings(
    login,
    assignments.length,
    links,
    hasCoursePageStructure(root),
    parserError
  );

  return {
    course_id: courseId,
    course_name: safeText(courseName) ?? "[redacted]",
    page: {
      title,
      utf8_bytes: new TextEncoder().encode(html).byteLength,
      login_page: login,
    },
    parser: {
      current_assignment_count: assignments.length,
      current_assignment_ids: bounded(assignments.map((assignment) => assignment.id)),
      tr_count: root.querySelectorAll("tr").length,
      assignment_row_count: root.querySelectorAll(".assignment-row").length,
      error: parserError,
    },
    discovery: {
      generic_assignment_link_count: links.length,
      unique_assignment_count: uniqueAssignmentIds.length,
      links: bounded(links),
    },
    structure: {
      tables: bounded(tableDiagnostics(root)),
      ...structure,
    },
    warnings,
  };
}

const courseInput = {
  course_id: z
    .string()
    .regex(/^\d+$/, "course_id must be numeric")
    .describe("The Gradescope student course ID"),
};

export function registerCourseDiagnosticTool(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "diagnose-course",
    {
      description:
        "Temporary B1 diagnostic: inspect the student-facing course page structure to distinguish an empty course from an assignment-parser selector mismatch. This tool will be removed after the permanent repair.",
      inputSchema: courseInput,
      outputSchema: diagnoseCourseOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id }) => {
      try {
        const course = await requireStudentCourse(api, course_id);
        const html = await api.fetchPage(`/courses/${course_id}`);
        return toolSuccess(diagnoseCoursePage(html, course_id, course.name));
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
