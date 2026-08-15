import { parse as parseHTML, type HTMLElement } from "node-html-parser";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseAssignmentPdfLink } from "./student-pdf.js";
import { requireStudentCourse } from "./student-access.js";
import type { GradescopeClient } from "./types.js";
import { READ_ONLY_ANNOTATIONS, toolError, toolSuccess } from "./tool-utils.js";

/**
 * Temporary PDF diagnostic surface. Keep all diagnostic-only code in this
 * module so it can be removed with one import and one registration call after
 * the live PDF parser is repaired.
 */

const MAX_DETAILS = 24;
const MAX_TEXT_LENGTH = 160;
const GRADESCOPE_ORIGIN = "https://www.gradescope.com";
const UPLOAD_HOST_PATTERN =
  /^production-gradescope-uploads\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i;
const PDF_PATH_PATTERN = /^\/uploads\/pdf_attachment\/file\/\d+\/[^/]+\.pdf$/i;
const SIGNED_PARAMETERS = [
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-Signature",
  "X-Amz-SignedHeaders",
] as const;

const boundedStringListSchema = z.object({
  items: z.array(z.string()),
  total_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const signedParameterSchema = z.object(
  Object.fromEntries(
    SIGNED_PARAMETERS.map((parameter) => [parameter, z.boolean()])
  ) as Record<(typeof SIGNED_PARAMETERS)[number], z.ZodBoolean>
);

const pdfAnchorSchema = z.object({
  scope: z.enum(["matching-dialog", "matching-form", "page"]),
  label: z.string().nullable(),
  protocol: z.string().nullable(),
  hostname: z.string().nullable(),
  pathname: z.string().nullable(),
  query_present: z.boolean(),
  download_pdf_label: z.boolean(),
  expected_upload_host: z.boolean(),
  expected_pdf_path: z.boolean(),
  signed_parameters: signedParameterSchema,
  parser_candidate: z.boolean(),
  rejection_reasons: z.array(z.string()),
});

const formSchema = z.object({
  action_path: z.string().nullable(),
  method: z.string().nullable(),
  matching_assignment: z.boolean(),
});

const buttonSchema = z.object({
  assignment_id: z.string().nullable(),
  label: z.string().nullable(),
  classes: z.array(z.string()),
});

export const diagnoseAssignmentPdfOutputSchema = z.object({
  course_id: z.string(),
  assignment_id: z.string(),
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
      pdf_marker_count: z.number().int().nonnegative(),
      submit_assignment_marker_count: z.number().int().nonnegative(),
    }),
  }),
  structure: z.object({
    forms: z.object({
      total_count: z.number().int().nonnegative(),
      matching_assignment_count: z.number().int().nonnegative(),
      items: z.array(formSchema),
      truncated: z.boolean(),
    }),
    assignment_buttons: z.object({
      matching_count: z.number().int().nonnegative(),
      items: z.array(buttonSchema),
      truncated: z.boolean(),
    }),
    dialogs: z.object({
      total_count: z.number().int().nonnegative(),
      matching_count: z.number().int().nonnegative(),
    }),
    pdf_like_anchors: z.object({
      total_count: z.number().int().nonnegative(),
      scoped_to_assignment_container: z.number().int().nonnegative(),
      items: z.array(pdfAnchorSchema),
      truncated: z.boolean(),
    }),
  }),
  parser: z.object({
    submission_form_found: z.boolean(),
    container_type: z.enum(["dialog", "form"]).nullable(),
    scoped_candidate_count: z.number().int().nonnegative(),
    accepted_link: z.boolean(),
    filename: z.string().nullable(),
    rejection_reasons: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
});

type Bounded<T> = {
  items: T[];
  total_count: number;
  truncated: boolean;
};

type PdfAnchorDiagnostic = z.infer<typeof pdfAnchorSchema>;

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
  return safeText(element.textContent);
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

function closestTag(element: HTMLElement, tagName: string): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.tagName.toLowerCase() === tagName) return current;
    const parent = current.parentNode as HTMLElement | null;
    current = parent && typeof parent.tagName === "string" ? parent : null;
  }
  return null;
}

function contains(container: HTMLElement, element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current === container) return true;
    const parent = current.parentNode as HTMLElement | null;
    current = parent && typeof parent.tagName === "string" ? parent : null;
  }
  return false;
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

function pathForUrl(
  value: string | null | undefined,
  base = GRADESCOPE_ORIGIN
): string | null {
  if (!value) return null;
  try {
    return new URL(value, `${base}/`).pathname;
  } catch {
    return null;
  }
}

function assignmentFormMatches(
  form: HTMLElement,
  courseId: string,
  assignmentId: string
): boolean {
  const action = form.getAttribute("action");
  if (!action) return false;
  try {
    const url = new URL(action, `${GRADESCOPE_ORIGIN}/`);
    return (
      url.origin === GRADESCOPE_ORIGIN &&
      url.pathname ===
        `/courses/${courseId}/assignments/${assignmentId}/submissions`
    );
  } catch {
    return false;
  }
}

function assignmentButtonId(element: HTMLElement): string | null {
  for (const attribute of [
    "data-assignment-id",
    "data-assignment_id",
    "data-assignment",
  ]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  return null;
}

function loginPageTitle(root: HTMLElement): string | null {
  return visibleText(root.querySelector("title"));
}

function scriptDiagnostics(root: HTMLElement) {
  const scripts = root.querySelectorAll("script");
  return {
    total_count: scripts.length,
    external_count: scripts.filter((script) => Boolean(script.getAttribute("src"))).length,
    inline_count: scripts.filter((script) => !script.getAttribute("src")).length,
    pdf_marker_count: scripts.filter((script) => /pdf|template/i.test(script.textContent ?? "")).length,
    submit_assignment_marker_count: scripts.filter((script) => /submitAssignment|assignment-id/i.test(script.textContent ?? "")).length,
  };
}

function anchorScope(
  anchor: HTMLElement,
  matchingForms: HTMLElement[],
  matchingDialogs: HTMLElement[]
): PdfAnchorDiagnostic["scope"] {
  if (matchingDialogs.some((dialog) => contains(dialog, anchor))) {
    return "matching-dialog";
  }
  if (matchingForms.some((form) => contains(form, anchor))) {
    return "matching-form";
  }
  return "page";
}

function inspectAnchor(
  anchor: HTMLElement,
  scope: PdfAnchorDiagnostic["scope"]
): PdfAnchorDiagnostic {
  const label = visibleText(anchor);
  const labelMatches = /download.*pdf/i.test(label ?? "");
  const href = anchor.getAttribute("href");
  const signedParameters = Object.fromEntries(
    SIGNED_PARAMETERS.map((parameter) => [parameter, false])
  ) as Record<(typeof SIGNED_PARAMETERS)[number], boolean>;
  const rejectionReasons: string[] = [];

  let protocol: string | null = null;
  let hostname: string | null = null;
  let pathname: string | null = null;
  let queryPresent = false;
  let expectedUploadHost = false;
  let expectedPdfPath = false;

  if (!labelMatches) rejectionReasons.push("label-does-not-match-download-pdf");
  if (!href) {
    rejectionReasons.push("missing-href");
  } else {
    try {
      const url = new URL(href, `${GRADESCOPE_ORIGIN}/`);
      protocol = url.protocol;
      hostname = url.hostname || null;
      pathname = url.pathname || null;
      queryPresent = url.search.length > 0;
      expectedUploadHost = UPLOAD_HOST_PATTERN.test(url.hostname);
      expectedPdfPath = PDF_PATH_PATTERN.test(url.pathname);

      if (url.protocol !== "https:") rejectionReasons.push("not-https");
      if (!expectedUploadHost) rejectionReasons.push("unexpected-upload-host");
      if (!expectedPdfPath) rejectionReasons.push("unexpected-pdf-path");
      for (const parameter of SIGNED_PARAMETERS) {
        signedParameters[parameter] = url.searchParams.has(parameter);
      }
      if (!SIGNED_PARAMETERS.every((parameter) => signedParameters[parameter])) {
        rejectionReasons.push("missing-signed-url-parameter");
      }
    } catch {
      rejectionReasons.push("invalid-href");
    }
  }

  return {
    scope,
    label,
    protocol,
    hostname,
    pathname,
    query_present: queryPresent,
    download_pdf_label: labelMatches,
    expected_upload_host: expectedUploadHost,
    expected_pdf_path: expectedPdfPath,
    signed_parameters: signedParameters,
    parser_candidate: rejectionReasons.length === 0,
    rejection_reasons: Array.from(new Set(rejectionReasons)),
  };
}

function isPdfLike(anchor: HTMLElement): boolean {
  const label = visibleText(anchor) ?? "";
  const href = anchor.getAttribute("href") ?? "";
  return /pdf|download|template/i.test(label) || /\.pdf(?:[?#]|$)/i.test(href);
}

function diagnosticWarnings(
  login: ReturnType<typeof loginDiagnostics>,
  matchingForms: HTMLElement[],
  matchingButtons: HTMLElement[],
  matchingDialogs: HTMLElement[],
  allPdfAnchors: HTMLElement[],
  scopedAnchors: PdfAnchorDiagnostic[],
  acceptedLink: boolean,
  scriptInfo: ReturnType<typeof scriptDiagnostics>
): string[] {
  const warnings: string[] = [];
  if (login.detected) {
    warnings.push(
      "authentication-page: the fetched course page looks like a Gradescope login page"
    );
  }
  if (matchingButtons.length > 0 && matchingForms.length === 0) {
    warnings.push(
      "browser-only-modal-possible: the assignment control exists, but the raw server HTML contains no matching submission form; Chrome may be showing JavaScript-rendered modal content"
    );
  }
  if (matchingForms.length === 0) {
    warnings.push(
      "submission-form-absent: no assignment-specific upload form was found in the fetched HTML"
    );
  }
  if (matchingForms.length > 0 && matchingDialogs.length === 0) {
    warnings.push(
      "dialog-absent: the assignment upload form was found, but it is not inside a dialog element"
    );
  }
  if (allPdfAnchors.length === 0) {
    warnings.push(
      "pdf-markup-absent: no PDF/download/template link was found in the raw fetched HTML"
    );
  } else if (scopedAnchors.length === 0) {
    warnings.push(
      "pdf-link-outside-assignment-container: PDF-like links exist, but none are inside the assignment form or matching dialog"
    );
  } else if (!acceptedLink) {
    warnings.push(
      "pdf-candidate-rejected: an assignment-scoped PDF-like link was found, but it failed one or more parser safety checks"
    );
  }
  if (
    matchingButtons.length > 0 &&
    matchingForms.length === 0 &&
    scriptInfo.pdf_marker_count > 0
  ) {
    warnings.push(
      "script-generated-pdf-possible: inline script content mentions PDF/template data while the corresponding modal is absent from raw HTML"
    );
  }
  return warnings;
}

export function diagnoseAssignmentPdfPage(
  html: string,
  courseId: string,
  assignmentId: string
) {
  const root = parseHTML(html);
  const login = loginDiagnostics(root);
  const forms = root.querySelectorAll("form");
  const matchingForms = forms.filter((form) =>
    assignmentFormMatches(form, courseId, assignmentId)
  );
  const buttons = root.querySelectorAll(
    "[data-assignment-id], [data-assignment_id], [data-assignment]"
  );
  const matchingButtons = buttons.filter(
    (button) => assignmentButtonId(button) === assignmentId
  );
  const dialogs = root.querySelectorAll("dialog");
  const matchingDialogs = dialogs.filter((dialog) =>
    matchingForms.some((form) => contains(dialog, form))
  );
  const allPdfAnchors = root.querySelectorAll("a[href]").filter(isPdfLike);
  const scopedAnchorElements = allPdfAnchors.filter(
    (anchor) =>
      matchingForms.some((form) => contains(form, anchor)) ||
      matchingDialogs.some((dialog) => contains(dialog, anchor))
  );
  const scopedAnchors = scopedAnchorElements.map((anchor) =>
    inspectAnchor(anchor, anchorScope(anchor, matchingForms, matchingDialogs))
  );
  const allAnchors = allPdfAnchors.map((anchor) =>
    inspectAnchor(anchor, anchorScope(anchor, matchingForms, matchingDialogs))
  );
  const parsed = parseAssignmentPdfLink(html, courseId, assignmentId);
  const containerType = matchingForms.length
    ? matchingDialogs.length > 0
      ? ("dialog" as const)
      : ("form" as const)
    : null;
  const scriptInfo = scriptDiagnostics(root);
  const rejectionReasons = Array.from(
    new Set(scopedAnchors.flatMap((anchor) => anchor.rejection_reasons))
  );

  return {
    course_id: courseId,
    assignment_id: assignmentId,
    fetched_path: `/courses/${courseId}`,
    page: {
      title: loginPageTitle(root),
      utf8_bytes: new TextEncoder().encode(html).byteLength,
      login_page: login,
      scripts: scriptInfo,
    },
    structure: {
      forms: {
        total_count: forms.length,
        matching_assignment_count: matchingForms.length,
        items: forms.map((form) => ({
          action_path: pathForUrl(form.getAttribute("action")),
          method: safeIdentifier(form.getAttribute("method"))?.toLowerCase() ?? null,
          matching_assignment: matchingForms.includes(form),
        })).slice(0, MAX_DETAILS),
        truncated: forms.length > MAX_DETAILS,
      },
      assignment_buttons: {
        matching_count: matchingButtons.length,
        items: matchingButtons.map((button) => ({
          assignment_id: assignmentButtonId(button),
          label: visibleText(button),
          classes: classNames(button),
        })).slice(0, MAX_DETAILS),
        truncated: matchingButtons.length > MAX_DETAILS,
      },
      dialogs: {
        total_count: dialogs.length,
        matching_count: matchingDialogs.length,
      },
      pdf_like_anchors: {
        total_count: allPdfAnchors.length,
        scoped_to_assignment_container: scopedAnchors.length,
        items: allAnchors.slice(0, MAX_DETAILS),
        truncated: allAnchors.length > MAX_DETAILS,
      },
    },
    parser: {
      submission_form_found: matchingForms.length > 0,
      container_type: containerType,
      scoped_candidate_count: scopedAnchors.length,
      accepted_link: parsed !== null,
      filename: parsed?.filename ?? null,
      rejection_reasons: rejectionReasons,
    },
    warnings: diagnosticWarnings(
      login,
      matchingForms,
      matchingButtons,
      matchingDialogs,
      allPdfAnchors,
      scopedAnchors,
      parsed !== null,
      scriptInfo
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
};

export function registerAssignmentPdfDiagnosticTool(
  server: McpServer,
  api: GradescopeClient
): void {
  server.registerTool(
    "diagnose-assignment-pdf",
    {
      description:
        "Temporary PDF diagnostic: inspect the raw student course page to determine whether an assignment-provided PDF link is absent, JavaScript-rendered, or rejected by the safety checks. Never returns signed URL values or raw HTML.",
      inputSchema,
      outputSchema: diagnoseAssignmentPdfOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ course_id, assignment_id }) => {
      try {
        await requireStudentCourse(api, course_id);
        const html = await api.fetchPage(`/courses/${course_id}`);
        return toolSuccess(
          diagnoseAssignmentPdfPage(html, course_id, assignment_id)
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
