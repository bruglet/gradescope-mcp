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

function statusWithScore(
  status: NormalizedSubmissionStatus,
  score: { score: number; maxScore: number } | null
): NormalizedSubmissionStatus {
  // Gradescope sometimes replaces the textual status with the released score
  // (for example, "86.0 / 100.0"). A complete score pair is safe evidence
  // that the work was graded, while the original display text remains in
  // statusRaw for callers that need it.
  return status === "unknown" && score ? "graded" : status;
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
  const scoreText = valueContent(scoreCell) ?? cells.map(textContent).find((text) => parseScore(text));
  const score = scoreText ? parseScore(scoreText) : null;
  const status = statusWithScore(statusFromRaw(statusRaw), score);
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
  const scoreText = valueContent(scoreCell) ?? cells.map(textContent).find((text) => parseScore(text));
  const score = scoreText ? parseScore(scoreText) : null;
  const status = statusWithScore(statusFromRaw(statusRaw), score);
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

function submissionPathFromValue(
  value: string | null | undefined,
  courseId?: string,
  assignmentId?: string
): string | null {
  if (!value) return null;

  try {
    const url = new URL(value, "https://www.gradescope.com/");
    if (url.origin !== "https://www.gradescope.com") return null;

    const match = url.pathname.match(
      /^\/courses\/(\d+)\/assignments\/(\d+)\/submissions\/(\d+)\/?$/
    );
    if (!match) return null;
    if (courseId && match[1] !== courseId) return null;
    if (assignmentId && match[2] !== assignmentId) return null;

    return `/courses/${match[1]}/assignments/${match[2]}/submissions/${match[3]}`;
  } catch {
    return null;
  }
}

export function parseSubmissionList(
  html: string,
  courseId?: string,
  assignmentId?: string
): GradescopeSubmission[] {
  const root = parseHTML(html);
  const submissions: GradescopeSubmission[] = [];
  const seenIds = new Set<string>();

  for (const link of root.querySelectorAll('a[href*="/submissions/"]')) {
    const href = submissionPathFromValue(
      link.getAttribute("href"),
      courseId,
      assignmentId
    );
    const id = href?.match(/\/submissions\/(\d+)$/)?.[1];
    if (!href || !id || seenIds.has(id)) continue;
    seenIds.add(id);
    submissions.push(submissionFromContainer(submissionContainer(link), id, href));
  }
  return submissions;
}

function questionSections(root: HTMLElement): HTMLElement[] {
  const primary = root.querySelectorAll(
    ".question, [data-question-id], .rubric-question, .question-group, [class*='question-group']"
  );
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
      textContent(
        section.querySelector(
          ".question-title, .submissionOutline--sectionHeading, .submissionOutlineQuestion--sectionHeading, .name, h2, h3, h4"
        )
      ) || textContent(section)
    );
    if (!name) continue;

    const score = [
      section.querySelector(".submissionOutlineQuestion--weightAndScore"),
      section.querySelector("[class*='weightAndScore']"),
      section.querySelector("[class*='score'], .points"),
    ]
      .map((element) => parseScore(textContent(element)))
      .find((value): value is { score: number; maxScore: number } => value !== null) ?? null;
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

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return null;
}

function scalarText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return nullableText(String(value));
}

function scalarNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? number : null;
}

function numericIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function recordNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const number = scalarNumber(record[key]);
    if (number !== null) return number;
  }
  return null;
}

function questionIdFromRecord(
  record: JsonRecord,
  includeRecordId: boolean
): string | null {
  const direct = numericIdentifier(
    recordValue(record, ["question_id", "questionId", "questionID"])
  );
  if (direct) return direct;

  const question = record.question;
  if (isJsonRecord(question)) {
    const nested = questionIdFromRecord(question, true);
    if (nested) return nested;
  } else {
    const nested = numericIdentifier(question);
    if (nested) return nested;
  }

  return includeRecordId ? numericIdentifier(record.id) : null;
}

function questionNameFromRecord(record: JsonRecord): string | null {
  for (const key of [
    "name",
    "title",
    "question_name",
    "questionName",
    "display_name",
    "displayName",
    "label",
  ]) {
    const value = scalarText(record[key]);
    if (value && !/^\(no title\)$/i.test(value)) return value;
  }

  const numberedTitle = scalarText(record.numbered_title);
  if (numberedTitle) {
    return /^question\b/i.test(numberedTitle)
      ? numberedTitle
      : `Question ${numberedTitle}`;
  }

  if (isJsonRecord(record.question)) {
    return questionNameFromRecord(record.question);
  }
  return null;
}

const maxScoreKeys = [
  "max_score",
  "maxScore",
  "points_possible",
  "pointsPossible",
  "max_points",
  "maxPoints",
  "total_points",
  "totalPoints",
  "weight",
  "points",
];

const explicitMaxScoreKeys = maxScoreKeys.filter((key) => key !== "points");

function questionMaxScore(record: JsonRecord): number | null {
  return recordNumber(record, maxScoreKeys);
}

function questionScore(record: JsonRecord): {
  score: number | null;
  maxScore: number | null;
} {
  const scoreValue =
    recordValue(record, [
      "score",
      "points_awarded",
      "pointsAwarded",
      "earned_score",
      "earnedScore",
    ]) ?? record.points;
  const scoreText = scalarText(scoreValue);
  const pair = scoreText ? parseScore(scoreText) : null;
  if (pair) return pair;

  return {
    score: scalarNumber(scoreValue),
    maxScore: recordNumber(record, explicitMaxScoreKeys),
  };
}

interface QuestionMetadata {
  name: string | null;
  maxScore: number | null;
}

function mergeQuestionMetadata(
  metadata: Map<string, QuestionMetadata>,
  id: string,
  next: QuestionMetadata
): void {
  const previous = metadata.get(id);
  metadata.set(id, {
    name: previous?.name ?? next.name,
    maxScore: previous?.maxScore ?? next.maxScore,
  });
}

function collectQuestionMetadata(
  value: unknown,
  metadata: Map<string, QuestionMetadata>,
  inheritedId: string | null = null,
  depth = 0
): void {
  if (depth > 8) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectQuestionMetadata(item, metadata, inheritedId, depth + 1);
    }
    return;
  }
  if (!isJsonRecord(value)) return;

  const id = questionIdFromRecord(value, true) ?? inheritedId;
  const name = questionNameFromRecord(value);
  const maxScore = questionMaxScore(value);
  if (id && (name !== null || maxScore !== null)) {
    mergeQuestionMetadata(metadata, id, { name, maxScore });
  }

  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(child) && !isJsonRecord(child)) continue;
    collectQuestionMetadata(
      child,
      metadata,
      numericIdentifier(key) ?? id,
      depth + 1
    );
  }
}

function objectEntries(value: unknown): Array<{ value: JsonRecord; key: string | null }> {
  if (Array.isArray(value)) {
    return value
      .filter(isJsonRecord)
      .map((item) => ({ value: item, key: null }));
  }
  if (!isJsonRecord(value)) return [];
  return Object.entries(value)
    .filter(([, item]) => isJsonRecord(item))
    .map(([key, item]) => ({ value: item as JsonRecord, key: numericIdentifier(key) }));
}

function parseViewerProps(root: HTMLElement): JsonRecord | null {
  const viewer = root.querySelector(
    'div[data-react-class="AssignmentSubmissionViewer"][data-react-props]'
  );
  const raw = viewer?.getAttribute("data-react-props");
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseViewerQuestions(
  props: JsonRecord
): GradescopeQuestionResult[] {
  const metadata = new Map<string, QuestionMetadata>();
  collectQuestionMetadata(props.questions, metadata);
  collectQuestionMetadata(props.outline, metadata);

  const inorderIds = Array.isArray(props.inorder_leaf_question_ids)
    ? props.inorder_leaf_question_ids
        .map(numericIdentifier)
        .filter((id): id is string => id !== null)
    : [];
  const order = new Map(inorderIds.map((id, index) => [id, index]));
  const entries = objectEntries(props.question_submissions).map((entry, index) => ({
    ...entry,
    index,
    id: questionIdFromRecord(entry.value, false) ?? entry.key,
  }));

  entries.sort((left, right) => {
    const leftOrder = left.id ? order.get(left.id) : undefined;
    const rightOrder = right.id ? order.get(right.id) : undefined;
    if (leftOrder === undefined && rightOrder === undefined) return left.index - right.index;
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    return leftOrder - rightOrder;
  });

  const questions: GradescopeQuestionResult[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const meta = entry.id ? metadata.get(entry.id) : undefined;
    const score = questionScore(entry.value);
    const maxScore = score.maxScore ?? meta?.maxScore ?? null;
    const name =
      questionNameFromRecord(entry.value) ??
      meta?.name ??
      (score.score !== null || maxScore !== null ? `Question ${index + 1}` : null);
    if (!name) continue;

    const key = entry.id ?? `${name}|${score.score ?? ""}|${maxScore ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push({
      name,
      score: score.score,
      maxScore,
      rubricItems: [],
      comments: [],
    });
  }
  return questions;
}

function parseViewerSubmission(root: HTMLElement): {
  score: number | null;
  maxScore: number | null;
  submissionStatus: NormalizedSubmissionStatus;
  statusRaw: string | null;
  submitted: boolean | null;
  submittedAt: string | null;
  late: boolean | null;
  lateness: string | null;
  questions: GradescopeQuestionResult[];
} | null {
  const props = parseViewerProps(root);
  if (!props) return null;

  const assignmentSubmission = isJsonRecord(props.assignment_submission)
    ? props.assignment_submission
    : {};
  const assignment = isJsonRecord(props.assignment) ? props.assignment : {};
  const scoreValue = recordValue(assignmentSubmission, ["score", "points_awarded", "pointsAwarded"]);
  const scorePair = scalarText(scoreValue) ? parseScore(scalarText(scoreValue) ?? "") : null;
  const score = scorePair?.score ?? scalarNumber(scoreValue);
  const maxScore =
    scorePair?.maxScore ??
    recordNumber(assignmentSubmission, maxScoreKeys) ??
    recordNumber(assignment, maxScoreKeys);
  const questions = parseViewerQuestions(props);
  const totalQuestionMax =
    questions.length > 0 && questions.every((question) => question.maxScore !== null)
      ? questions.reduce((total, question) => total + (question.maxScore ?? 0), 0)
      : null;
  const resolvedMaxScore = maxScore ??
    (totalQuestionMax !== null ? totalQuestionMax : null);
  const statusValue = recordValue(assignmentSubmission, [
    "submission_status",
    "submissionStatus",
    "status",
  ]);
  const statusRawCandidate = scalarText(statusValue);
  const rawStatus = statusFromRaw(statusRawCandidate);
  const status = statusWithScore(
    rawStatus,
    score !== null && resolvedMaxScore !== null
      ? { score, maxScore: resolvedMaxScore }
      : null
  );
  const explicitSubmitted = recordValue(assignmentSubmission, [
    "submitted",
    "is_submitted",
    "isSubmitted",
  ]);
  const submitted =
    typeof explicitSubmitted === "boolean"
      ? explicitSubmitted
      : submittedFromStatus(status);
  const submittedAt = scalarText(
    recordValue(assignmentSubmission, [
      "submitted_at",
      "submittedAt",
      "created_at",
      "createdAt",
    ])
  );
  const explicitLate = recordValue(assignmentSubmission, ["late", "is_late", "isLate"]);
  const lateness = scalarText(
    recordValue(assignmentSubmission, ["lateness", "late_by", "lateBy", "late_text"])
  );
  const late =
    typeof explicitLate === "boolean"
      ? explicitLate
      : lateFromText([lateness, statusRawCandidate]);

  return {
    score,
    maxScore: resolvedMaxScore,
    submissionStatus: status,
    statusRaw: rawStatus === "unknown" ? null : statusRawCandidate,
    submitted,
    submittedAt,
    late,
    lateness,
    questions,
  };
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
  const viewerSubmission = parseViewerSubmission(root);
  const htmlStatusRaw = nullableText(valueContent(statusElement));
  const statusRaw = htmlStatusRaw ?? viewerSubmission?.statusRaw ?? null;
  const status =
    htmlStatusRaw !== null
      ? statusFromRaw(htmlStatusRaw)
      : viewerSubmission?.submissionStatus ?? "unknown";
  const htmlScore = score;
  const resolvedScore = htmlScore?.score ?? viewerSubmission?.score ?? null;
  const resolvedMaxScore = htmlScore?.maxScore ?? viewerSubmission?.maxScore ?? null;
  const submissionStatus = statusWithScore(
    status,
    resolvedScore !== null && resolvedMaxScore !== null
      ? { score: resolvedScore, maxScore: resolvedMaxScore }
      : null
  );
  const lateElement = summary.querySelector("[class*='late'], [class*='lateness']");
  const lateText =
    valueContent(lateElement) ??
    viewerSubmission?.lateness ??
    (statusRaw && /\blate\b/i.test(statusRaw) ? statusRaw : null);
  const htmlSubmittedAt = valueContent(summary.querySelector("time[datetime], [class*='submitted']"));
  const htmlQuestions = parseQuestionResults(root);

  return {
    id: "",
    score: resolvedScore,
    maxScore: resolvedMaxScore,
    submissionStatus,
    statusRaw,
    submitted: viewerSubmission?.submitted ?? submittedFromStatus(submissionStatus),
    submittedAt: htmlSubmittedAt ?? viewerSubmission?.submittedAt ?? null,
    late: viewerSubmission?.late ?? lateFromText([lateText, statusRaw]),
    lateness: lateText,
    url: "",
    questions: htmlQuestions.length > 0 ? htmlQuestions : viewerSubmission?.questions ?? [],
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
