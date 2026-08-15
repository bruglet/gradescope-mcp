import { parse as parseHTML, type HTMLElement, type Node } from "node-html-parser";
import type {
  GradescopeAssignment,
  GradescopeCourse,
  GradescopeQuestionResult,
  GradescopeRegradeRequest,
  GradescopeRubricItem,
  GradescopeSubmission,
  GradescopeSubmissionDetail,
  NormalizedRegradeStatus,
  NormalizedSubmissionStatus,
} from "./types.js";

type CourseRole = GradescopeCourse["role"];

function textContent(element: HTMLElement | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : null;
}

function valueContent(element: HTMLElement | null): string | null {
  if (!element) return null;
  const machineValue = element.querySelector("time[datetime]")?.getAttribute("datetime");
  return nullableText(machineValue ?? textContent(element));
}

function parseNumber(text: string): number | null {
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number.parseFloat(match[0]);
  return Number.isNaN(number) ? null : number;
}

function parseScore(text: string): { score: number; maxScore: number } | null {
  const match = text.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const score = Number.parseFloat(match[1]);
  const maxScore = Number.parseFloat(match[2]);
  return Number.isNaN(score) || Number.isNaN(maxScore) ? null : { score, maxScore };
}

function normalizedHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function headerNames(row: HTMLElement): string[] {
  const table = row.closest("table");
  const headerRow = table?.querySelector("thead tr") ?? table?.querySelector("tr");
  if (!headerRow || headerRow === row) return [];
  return headerRow.querySelectorAll("th, td").map((cell) => normalizedHeader(textContent(cell)));
}

function cellByHeader(
  cells: HTMLElement[],
  headers: string[],
  matcher: RegExp
): HTMLElement | null {
  const index = headers.findIndex((header) => matcher.test(header));
  return index >= 0 ? cells[index] ?? null : null;
}

function cellByClass(cells: HTMLElement[], matcher: RegExp): HTMLElement | null {
  return (
    cells.find((cell) => matcher.test((cell.getAttribute("class") ?? "").toLowerCase())) ??
    null
  );
}

function firstMatchingCell(
  cells: HTMLElement[],
  headers: string[],
  headerMatcher: RegExp,
  classMatcher: RegExp
): HTMLElement | null {
  return cellByHeader(cells, headers, headerMatcher) ?? cellByClass(cells, classMatcher);
}

function assignmentPathFromValue(
  value: string | null | undefined,
  courseId: string | undefined
): string | null {
  if (!value || !courseId) return null;

  try {
    const url = new URL(value, "https://www.gradescope.com/");
    if (url.origin !== "https://www.gradescope.com") return null;

    const match = url.pathname.match(
      new RegExp(`^/courses/${courseId}/assignments/(\\d+)/?$`)
    );
    return match ? `/courses/${courseId}/assignments/${match[1]}` : null;
  } catch {
    return null;
  }
}

function rowAssignmentPath(
  row: HTMLElement,
  courseId: string | undefined
): string | null {
  if (!courseId) return null;

  const elements = [row, ...row.querySelectorAll("*")];
  for (const element of elements) {
    for (const attribute of ["href", "data-url", "data-href", "action"]) {
      const path = assignmentPathFromValue(
        element.getAttribute(attribute),
        courseId
      );
      if (path) return path;
    }
  }
  return null;
}

function rowAssignmentId(row: HTMLElement): string | null {
  const candidates: Array<{ id: string; priority: number }> = [];
  const elements = [row, ...row.querySelectorAll("*")];

  for (const element of elements) {
    for (const attribute of [
      "data-assignment-id",
      "data-assignment_id",
      "data-assignment",
    ]) {
      const value = element.getAttribute(attribute)?.trim() ?? "";
      if (/^\d+$/.test(value)) candidates.push({ id: value, priority: 0 });
    }

    const elementId = element.getAttribute("id")?.trim() ?? "";
    const assignmentId = elementId.match(/^assignment[-_](\d+)$/i)?.[1];
    if (assignmentId) candidates.push({ id: assignmentId, priority: 1 });

    const dataId = element.getAttribute("data-id")?.trim() ?? "";
    if (/^\d+$/.test(dataId)) candidates.push({ id: dataId, priority: 2 });
  }

  if (candidates.length === 0) return null;

  const bestPriority = Math.min(...candidates.map(({ priority }) => priority));
  const bestIds = new Set(
    candidates
      .filter(({ priority }) => priority === bestPriority)
      .map(({ id }) => id)
  );
  return bestIds.size === 1 ? [...bestIds][0] : null;
}

function textBeforeDescendant(root: HTMLElement, target: HTMLElement): string | null {
  let text = "";

  function visit(node: Node): boolean {
    for (const child of node.childNodes) {
      if (child === target) return true;
      if (child.childNodes.length > 0) {
        if (visit(child)) return true;
      } else {
        text += child.textContent;
      }
    }
    return false;
  }

  return visit(root) ? text : null;
}

function labeledDateContent(
  element: HTMLElement | null,
  labelPattern: RegExp
): string | null {
  if (!element) return null;

  const times = element.querySelectorAll("time[datetime]");
  for (const time of times) {
    const timeText = textContent(time);
    const timeLabel = time.getAttribute("aria-label") ?? "";
    if (labelPattern.test(timeText) || labelPattern.test(timeLabel)) {
      const displayedDate =
        timeText.match(
          new RegExp(`${labelPattern.source}\\s*:?\\s*(.+)$`, labelPattern.flags)
        )?.[1] ?? timeText;
      return nullableText(time.getAttribute("datetime") ?? displayedDate);
    }

    const textBefore = textBeforeDescendant(element, time);
    if (textBefore && labelPattern.test(textBefore)) {
      return nullableText(time.getAttribute("datetime") ?? textContent(time));
    }
  }

  const text = textContent(element);
  const match = text.match(
    new RegExp(`${labelPattern.source}\\s*:?\\s*(.+)$`, labelPattern.flags)
  );
  return nullableText(match?.[1] ?? null);
}

function statusFromRaw(raw: string | null): NormalizedSubmissionStatus {
  if (!raw) return "unknown";
  const value = raw.toLowerCase();
  if (/not submitted|unsubmitted|no submission|missing/.test(value)) return "unsubmitted";
  if (/graded|score released|returned/.test(value)) return "graded";
  if (/submitted|turned in|on time|late/.test(value)) return "submitted";
  return "unknown";
}

function submittedFromStatus(status: NormalizedSubmissionStatus): boolean | null {
  if (status === "submitted" || status === "graded") return true;
  if (status === "unsubmitted") return false;
  return null;
}

function lateFromText(values: Array<string | null>): boolean | null {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  if (/\blate\b|overdue/.test(text)) return true;
  if (/\bon time\b|on-time|not late/.test(text)) return false;
  return null;
}

function roleFromHeading(value: string): CourseRole {
  const heading = value.toLowerCase();
  if (heading.includes("instructor")) return "instructor";
  if (heading.includes("teaching assistant") || /\bta\b/.test(heading)) return "ta";
  if (heading.includes("student")) return "student";
  return "unknown";
}

function parseCourseList(
  courseList: HTMLElement,
  role: CourseRole,
  courses: GradescopeCourse[],
  seenIds: Set<string>,
  inheritedTerm: string | null = null
): void {
  let currentTerm = inheritedTerm;
  for (const child of courseList.childNodes) {
    const element = child as HTMLElement;
    if (!element || !("classList" in element)) continue;

    if (element.classList.contains("courseList--term")) {
      currentTerm = nullableText(textContent(element));
      continue;
    }

    if (element.classList.contains("courseList--coursesForTerm")) {
      for (const card of element.querySelectorAll("a.courseBox")) {
        const href = card.getAttribute("href") ?? "";
        const id = href.match(/\/courses\/(\d+)/)?.[1];
        if (!id || seenIds.has(id)) continue;

        const shortName = textContent(card.querySelector(".courseBox--shortname"));
        const fullName = textContent(card.querySelector(".courseBox--name"));
        seenIds.add(id);
        courses.push({
          id,
          name: fullName || shortName,
          shortName: shortName || fullName,
          term: currentTerm,
          role,
          url: href,
        });
      }
      continue;
    }

    if (element.classList.contains("courseList--inactiveCourses")) {
      parseCourseList(element, role, courses, seenIds, currentTerm);
    }
  }
}

export function parseDashboard(html: string): GradescopeCourse[] {
  const root = parseHTML(html);
  const account = root.querySelector("#account-show") ?? root;
  const roleMap = new Map<HTMLElement, CourseRole>();

  for (const heading of account.querySelectorAll("h2.pageHeading, h2")) {
    const role = roleFromHeading(textContent(heading));
    let sibling = heading.nextElementSibling;
    while (sibling) {
      if (sibling.classList.contains("courseList")) {
        roleMap.set(sibling, role);
        break;
      }
      if (sibling.tagName === "H2") break;
      sibling = sibling.nextElementSibling;
    }
  }

  // Current student account pages may label the document "Your Courses"
  // without rendering a textual "Student Courses" section heading. In that
  // specific shape, unlabelled course lists are the student's own courses.
  // Keep the fallback disabled when an explicit instructor/TA section exists
  // so role separation remains fail-closed.
  const pageTitle = textContent(root.querySelector("title")).toLowerCase();
  const hasExplicitNonStudentSection = [...roleMap.values()].some(
    (role) => role === "instructor" || role === "ta"
  );
  const useStudentDashboardFallback =
    /\byour courses\b/.test(pageTitle) && !hasExplicitNonStudentSection;

  const courses: GradescopeCourse[] = [];
  const seenIds = new Set<string>();
  for (const courseList of account.querySelectorAll(".courseList")) {
    const mappedRole = roleMap.get(courseList);
    const role =
      mappedRole === "unknown" && useStudentDashboardFallback
        ? "student"
        : mappedRole ?? (useStudentDashboardFallback ? "student" : "unknown");
    parseCourseList(courseList, role, courses, seenIds);
  }
  return courses;
}

function assignmentType(row: HTMLElement, href: string): string {
  const typeElement = row.querySelector(".assignment-type, .badge, [data-assignment-type]");
  const type = nullableText(textContent(typeElement));
  if (type) return type.toLowerCase();
  if (href.includes("programming")) return "programming";
  if (href.includes("online")) return "online";
  return "unknown";
}

function assignmentFromRow(
  row: HTMLElement,
  courseId?: string
): GradescopeAssignment | null {
  const link = row.querySelector('a[href*="/assignments/"]');
  const linkedHref = link?.getAttribute("href") ?? "";
  const linkedId = linkedHref.match(/\/assignments\/(\d+)/)?.[1];
  const rowPath = rowAssignmentPath(row, courseId);
  const id = linkedId ?? rowPath?.match(/\/assignments\/(\d+)/)?.[1] ?? rowAssignmentId(row);
  if (!id) return null;

  const href = linkedHref || rowPath || (courseId ? `/courses/${courseId}/assignments/${id}` : "");
  if (!href) return null;

  const cells = row.querySelectorAll("td, th");
  const headers = headerNames(row);
  const rowText = textContent(row);

  const lateDueCell =
    firstMatchingCell(
      cells,
      headers,
      /late due|late deadline|late submission deadline/,
      /late.*due|late.*deadline|late.*date/
    ) ??
    cells.find((cell) =>
      /\blate\s+(?:due\s+date|deadline)\b/i.test(textContent(cell))
    ) ??
    null;
  const dueCell =
    cellByHeader(cells, headers, /^(?:due|due date|deadline|deadline date)$/) ??
    firstMatchingCell(
      cells,
      headers,
      /^(?!.*late).*(due|deadline)/,
      /due|deadline|date/
    );
  const statusCell = firstMatchingCell(cells, headers, /(^| )status($| )/, /status|submission/);
  const scoreCell = firstMatchingCell(cells, headers, /score|grade|points/, /score|grade|points/);
  const submittedAtCell = firstMatchingCell(
    cells,
    headers,
    /submitted at|submission time|timestamp/,
    /submitted|timestamp|time/
  );
  const lateCell = firstMatchingCell(
    cells,
    headers,
    /^(?!.*due).*(late|lateness|overdue)/,
    /late(?!.*due)|lateness/
  );

  const statusRaw = nullableText(valueContent(statusCell));
  const status = statusFromRaw(statusRaw);
  const scoreText = valueContent(scoreCell) ?? cells.map(textContent).find((text) => parseScore(text));
  const score = scoreText ? parseScore(scoreText) : null;
  const lateText = valueContent(lateCell) ?? (statusRaw && /\blate\b/i.test(statusRaw) ? statusRaw : null);
  const late = lateFromText([lateText, statusRaw]);
  const lateDueDate =
    labeledDateContent(lateDueCell, /\blate\s+(?:due\s+date|deadline)\b/i) ??
    valueContent(lateDueCell);
  const nameCell =
    cellByHeader(cells, headers, /^(?:name|assignment)$/) ?? cells[0] ?? null;

  return {
    id,
    name: nullableText(textContent(link)) ?? textContent(nameCell),
    type: assignmentType(row, href),
    dueDate: valueContent(dueCell),
    lateDueDate,
    released: !row.querySelector(".unreleased, .draft") && !/\bunreleased\b/i.test(rowText),
    submissionStatus: status,
    statusRaw,
    submitted: submittedFromStatus(status),
    submittedAt: valueContent(submittedAtCell),
    late,
    lateness: lateText,
    pointsPossible: score?.maxScore ?? null,
    pointsAwarded: score?.score ?? null,
    url: href,
  };
}

export function parseAssignmentList(
  html: string,
  courseId?: string
): GradescopeAssignment[] {
  const root = parseHTML(html);
  const assignments: GradescopeAssignment[] = [];
  const seenIds = new Set<string>();

  for (const row of root.querySelectorAll("tr, .assignment-row")) {
    const assignment = assignmentFromRow(row, courseId);
    if (!assignment || seenIds.has(assignment.id)) continue;
    seenIds.add(assignment.id);
    assignments.push(assignment);
  }
  return assignments;
}

function submissionContainer(link: HTMLElement): HTMLElement {
  return (
    link.closest("tr") ??
    link.closest(".submission-row") ??
    link.closest("[class*='submission-card']") ??
    link.closest("[class*='submission']") ??
    link
  );
}

function submissionFromContainer(
  container: HTMLElement,
  id: string,
  url: string
): GradescopeSubmission {
  const cells = container.querySelectorAll("td, th");
  const headers = headerNames(container);
  const containerText = textContent(container);
  const statusCell = firstMatchingCell(cells, headers, /(^| )status($| )/, /status|submission/);
  const scoreCell = firstMatchingCell(cells, headers, /score|grade|points/, /score|grade|points/);
  const submittedAtCell = firstMatchingCell(
    cells,
    headers,
    /submitted at|submission time|timestamp|submitted/,
    /submitted|timestamp|time|date/
  );
  const lateCell = firstMatchingCell(cells, headers, /late|lateness/, /late|lateness/);

  const statusRaw = nullableText(valueContent(statusCell));
  const status = statusFromRaw(statusRaw);
  const scoreText = valueContent(scoreCell) ?? cells.map(textContent).find((text) => parseScore(text));
  const score = scoreText ? parseScore(scoreText) : null;
  const lateText = valueContent(lateCell) ?? (statusRaw && /\blate\b/i.test(statusRaw) ? statusRaw : null);
  const late = lateFromText([lateText, statusRaw]);
  const submittedAt =
    valueContent(submittedAtCell) ??
    valueContent(container.querySelector("time[datetime]"));

  return {
    id,
    score: score?.score ?? null,
    maxScore: score?.maxScore ?? null,
    submissionStatus: status,
    statusRaw: statusRaw ?? (/(submitted|graded|missing|late|not submitted)/i.test(containerText) ? containerText : null),
    submitted: submittedFromStatus(status),
    submittedAt,
    late,
    lateness: lateText,
    url,
  };
}

export function parseSubmissionList(html: string): GradescopeSubmission[] {
  const root = parseHTML(html);
  const submissions: GradescopeSubmission[] = [];
  const seenIds = new Set<string>();

  for (const link of root.querySelectorAll('a[href*="/submissions/"]')) {
    const href = link.getAttribute("href") ?? "";
    const id = href.match(/\/submissions\/(\d+)/)?.[1];
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    submissions.push(submissionFromContainer(submissionContainer(link), id, href));
  }
  return submissions;
}

function questionSections(root: HTMLElement): HTMLElement[] {
  const primary = root.querySelectorAll(".question, [data-question-id], .rubric-question");
  return primary.length > 0 ? primary : root.querySelectorAll("[class*='question-']");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseQuestionResults(root: HTMLElement): GradescopeQuestionResult[] {
  const questions: GradescopeQuestionResult[] = [];
  const seen = new Set<string>();

  for (const section of questionSections(root)) {
    const name = nullableText(
      textContent(section.querySelector(".question-title, .name, h3, h4")) || textContent(section)
    );
    if (!name) continue;

    const scoreElement = section.querySelector("[class*='score'], .points");
    const score = parseScore(textContent(scoreElement));
    const key = `${name}|${score?.score ?? ""}|${score?.maxScore ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rubricItems: GradescopeRubricItem[] = [];
    for (const rubric of section.querySelectorAll(
      ".rubricItem, [class*='rubric-item'], .rubric-row"
    )) {
      const description = nullableText(
        textContent(rubric.querySelector(".rubricItem--description, .description, td:first-child"))
      );
      if (!description) continue;
      const points = parseNumber(
        textContent(rubric.querySelector(".rubricItem--points, .points, td:last-child"))
      ) ?? 0;
      const className = rubric.getAttribute("class") ?? "";
      const applied =
        !!rubric.querySelector(".rubricItem--selected, .selected, .applied, .checked") ||
        /selected|applied|checked/.test(className);
      rubricItems.push({ description, points, applied });
    }

    const comments = uniqueStrings(
      section
        .querySelectorAll(".comment, [class*='comment'], .annotation")
        .map((comment) => textContent(comment))
    );

    questions.push({
      name,
      score: score?.score ?? null,
      maxScore: score?.maxScore ?? null,
      rubricItems,
      comments,
    });
  }
  return questions;
}

export function parseSubmissionDetail(html: string): GradescopeSubmissionDetail {
  const root = parseHTML(html);
  const summary = root.querySelector(
    ".submissionOutline, [class*='submission-outline'], main"
  ) ?? root;
  const scoreElement = summary.querySelector(
    ".submissionOutline--score, [class*='total-score'], .score"
  );
  const score = parseScore(textContent(scoreElement));
  const statusElement = summary.querySelector(
    ".submissionStatus, [data-status], [class*='status']"
  );
  const statusRaw = nullableText(valueContent(statusElement));
  const submissionStatus = statusFromRaw(statusRaw);
  const lateElement = summary.querySelector("[class*='late'], [class*='lateness']");
  const lateText = valueContent(lateElement) ?? (statusRaw && /\blate\b/i.test(statusRaw) ? statusRaw : null);

  return {
    id: "",
    score: score?.score ?? null,
    maxScore: score?.maxScore ?? null,
    submissionStatus,
    statusRaw,
    submitted: submittedFromStatus(submissionStatus),
    submittedAt: valueContent(summary.querySelector("time[datetime], [class*='submitted']")),
    late: lateFromText([lateText, statusRaw]),
    lateness: lateText,
    url: "",
    questions: parseQuestionResults(root),
  };
}

function regradeStatusFromRaw(raw: string | null): NormalizedRegradeStatus {
  if (!raw) return "unknown";
  const value = raw.toLowerCase();
  if (/pending|open|awaiting/.test(value)) return "pending";
  if (/approved|accepted|granted/.test(value)) return "approved";
  if (/denied|rejected|declined/.test(value)) return "denied";
  if (/resolved|closed|complete|completed/.test(value)) return "resolved";
  return "unknown";
}

export function parseRegradeRequests(html: string): GradescopeRegradeRequest[] {
  const root = parseHTML(html);
  const candidates = root.querySelectorAll(
    'tr, .regradeRequest, [class*="regradeRequest"], [data-regrade-request]'
  );
  const requests: GradescopeRegradeRequest[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const rowText = textContent(candidate);
    const link = candidate.querySelector('a[href*="regrade"]');
    const href = link?.getAttribute("href") ?? null;
    const id = href?.match(/regrade_requests\/(\d+)/)?.[1] ?? href?.match(/\/(\d+)$/)?.[1] ?? null;
    if (!id && !/regrade/i.test(rowText)) continue;

    const cells = candidate.querySelectorAll("td, th");
    const headers = headerNames(candidate);
    const statusCell = firstMatchingCell(cells, headers, /status/, /status/);
    const questionCell = firstMatchingCell(cells, headers, /question/, /question/);
    const explanationCell = firstMatchingCell(cells, headers, /explanation|reason/, /explanation|reason/);
    const responseCell = firstMatchingCell(cells, headers, /response|reply/, /response|reply/);
    const createdCell = firstMatchingCell(cells, headers, /created|requested|date|time/, /created|requested|date|time/);
    const statusRaw = nullableText(valueContent(statusCell));
    const questionName = nullableText(valueContent(questionCell));
    const explanation = nullableText(valueContent(explanationCell));
    const response = nullableText(valueContent(responseCell));
    const createdAt = nullableText(valueContent(createdCell));
    const key = id ?? `${questionName ?? ""}|${createdAt ?? ""}|${explanation ?? rowText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    requests.push({
      id,
      questionName,
      status: regradeStatusFromRaw(statusRaw),
      statusRaw,
      explanation,
      response,
      createdAt,
      url: href,
    });
  }

  return requests;
}
