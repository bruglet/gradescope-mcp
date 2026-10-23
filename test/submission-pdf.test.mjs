import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GradescopeAPI } from "../dist/gradescope-api.js";
import { parseSubmissionPdfLink } from "../dist/student-pdf.js";

const fixture = readFileSync(new URL("./fixtures/submission-pdf.html", import.meta.url), "utf8");
const originalUrl = parseSubmissionPdfLink(fixture, "301").url;

function viewer(props) {
  const encoded = JSON.stringify(props).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<div data-react-class="AssignmentSubmissionViewer" data-react-props="${encoded}"></div>`;
}

function originalViewer(url) {
  return viewer({ assignment_submission: { id: 301 }, paths: { original_file_path: url } });
}

test("finds only the matching submission viewer's original PDF", () => {
  assert.deepEqual(parseSubmissionPdfLink(fixture, "301"), {
    url: originalUrl,
    filename: "Submitted_Work.pdf",
  });
  assert.equal(parseSubmissionPdfLink(fixture, "302"), null);
  assert.equal(parseSubmissionPdfLink(viewer({
    assignment_submission: { id: 301 },
    paths: { graded_pdf_path: originalUrl },
  }), "301"), null);
  assert.equal(parseSubmissionPdfLink('<div data-react-class="AssignmentSubmissionViewer" data-react-props="bad-json"></div>', "301"), null);
  assert.equal(parseSubmissionPdfLink(viewer(null), "301"), null);
  assert.equal(parseSubmissionPdfLink("<main>No PDF</main>", "301"), null);
});

test("rejects unsigned, non-PDF, foreign, and credential-bearing original URLs", () => {
  for (const url of [
    originalUrl.split("?")[0],
    originalUrl.replace("https:", "http:"),
    originalUrl.replace("production-gradescope-uploads.s3-us-west-2.amazonaws.com", "evil.example"),
    originalUrl.replace("amazonaws.com", "amazonaws.com.evil.example"),
    originalUrl.replace("https://", "https://user:secret@"),
    originalUrl.replace(".com/", ".com:8443/"),
    originalUrl.replace("pdf_attachment/file", "page/file"),
    originalUrl.replace("Submitted_Work.pdf", "page.jpg"),
    originalUrl + "#fragment",
    "/courses/101/assignments/201/submissions/301.pdf",
  ]) {
    assert.equal(parseSubmissionPdfLink(originalViewer(url), "301"), null);
  }
  assert.equal(parseSubmissionPdfLink(originalViewer(originalUrl.replace("Submitted_Work", "bad%2Fname")), "301").filename, "submission-301.pdf");
});

async function withDownload(responseFactory, check) {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, cookie: new Headers(init.headers).get("cookie"), redirect: init.redirect });
    if (url.endsWith("/login") && method === "GET") {
      return new Response('<input name="authenticity_token" value="fixture">', {
        headers: { "set-cookie": "session=private; Path=/; Secure" },
      });
    }
    if (url.endsWith("/login") && method === "POST") {
      return new Response("", { status: 302, headers: { location: "/account" } });
    }
    if (url.endsWith("/account")) return new Response("<main>Account</main>");
    if (url.endsWith("/courses/101/assignments/201/submissions/301")) return new Response(fixture);
    assert.equal(url, originalUrl, "only the original upload may be requested");
    return responseFactory();
  };
  try {
    await check(new GradescopeAPI("fixture@example.edu", "fixture", 0), calls);
  } finally {
    globalThis.fetch = savedFetch;
  }
}

test("downloads the original upload with GET, without cookies or graded export requests", async () => {
  await withDownload(() => new Response("%PDF-1.7\noriginal"), async (api, calls) => {
    const result = await api.fetchSubmissionPdf("101", "201", "301");
    assert.equal(result.filename, "Submitted_Work.pdf");
    assert.equal(new TextDecoder().decode(result.bytes), "%PDF-1.7\noriginal");
    assert.ok(calls.find((call) => call.url.endsWith("/submissions/301")).cookie.includes("session=private"));
    assert.deepEqual(calls.at(-1), { url: originalUrl, method: "GET", cookie: null, redirect: "manual" });
    assert.deepEqual(calls.filter((call) => call.method !== "GET").map((call) => call.url), ["https://www.gradescope.com/login"]);
    assert.equal(calls.some((call) => call.url.endsWith("/submissions/301.pdf")), false);
  });
});

test("rejects redirects, failed downloads, non-PDF bytes, and oversized PDFs", async () => {
  const cases = [
    [() => new Response("", { status: 302, headers: { location: "https://evil.example/" } }), /unexpected redirect/],
    [() => new Response("", { status: 403 }), /failed \(403\)/],
    [() => new Response("<html>not a PDF</html>"), /not a PDF/],
    [() => new Response("%PDF-", { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }), /25 MiB/],
    [() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(25 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } })), /25 MiB/],
  ];
  for (const [responseFactory, pattern] of cases) {
    await withDownload(responseFactory, async (api) => {
      await assert.rejects(() => api.fetchSubmissionPdf("101", "201", "301"), pattern);
    });
  }
});

test("does not download when the viewer has no original PDF and validates IDs first", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No external requests expected"); };
  try {
    const api = new GradescopeAPI("fixture@example.edu", "fixture", 0);
    api.fetchPage = async () => "<main>No PDF</main>";
    assert.equal(await api.fetchSubmissionPdf("101", "201", "301"), null);
    api.fetchPage = async () => { throw new Error("No page requests expected"); };
    for (const ids of [["bad", "201", "301"], ["101", "bad", "301"], ["101", "201", "../301"]]) {
      await assert.rejects(() => api.fetchSubmissionPdf(...ids), /IDs must be numeric/);
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});
