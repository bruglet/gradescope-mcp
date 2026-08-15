import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GradescopeAPI } from "../dist/gradescope-api.js";

test("allows login POST but keeps authenticated Gradescope access GET-only and same-origin", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method });

    if (url.endsWith("/login") && method === "GET") {
      return new Response(
        '<form><input name="authenticity_token" value="test-token"></form>',
        { status: 200 }
      );
    }
    if (url.endsWith("/login") && method === "POST") {
      return new Response("", { status: 302, headers: { location: "/account" } });
    }
    if (url.endsWith("/courses/101")) {
      return new Response("", {
        status: 302,
        headers: { location: "https://evil.example/collect" },
      });
    }
    return new Response("<html><body>student page</body></html>", { status: 200 });
  };

  try {
    const api = new GradescopeAPI("student@example.com", "password", 0);
    await api.fetchPage("/account");

    await assert.rejects(
      () => api.fetchPage("https://evil.example/collect"),
      /same origin/
    );
    await assert.rejects(() => api.fetchPage("/courses/101"), /same origin/);

    const nonGetCalls = calls.filter(({ method }) => method !== "GET");
    assert.deepEqual(nonGetCalls, [
      { url: "https://www.gradescope.com/login", method: "POST" },
    ]);
    assert.equal(calls.some(({ url }) => url.includes("evil.example")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetches provided PDFs with an external GET and never sends Gradescope cookies", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = readFileSync(
    new URL("./fixtures/assignment-pdf.html", import.meta.url),
    "utf8"
  );
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({ url, method, hasCookie: headers.has("cookie") });

    if (url.endsWith("/login") && method === "GET") {
      return new Response(
        '<form><input name="authenticity_token" value="test-token"></form>',
        { status: 200 }
      );
    }
    if (url.endsWith("/login") && method === "POST") {
      return new Response("", { status: 302, headers: { location: "/account" } });
    }
    if (url.endsWith("/courses/101")) {
      return new Response(fixture, { status: 200 });
    }
    if (url.startsWith("https://production-gradescope-uploads.")) {
      return new Response("%PDF-1.7\nfixture", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return new Response("<html><body>student page</body></html>", { status: 200 });
  };

  try {
    const api = new GradescopeAPI("student@example.com", "password", 0);
    const pdf = await api.fetchAssignmentPdf("101", "701");

    assert.equal(pdf?.filename, "Reaction_Maze_.pdf");
    assert.equal(pdf?.mimeType, "application/pdf");
    assert.equal(new TextDecoder().decode(pdf?.bytes), "%PDF-1.7\nfixture");

    const externalCall = calls.find(({ url }) =>
      url.startsWith("https://production-gradescope-uploads.")
    );
    assert.deepEqual(externalCall, {
      url: externalCall.url,
      method: "GET",
      hasCookie: false,
    });
    assert.deepEqual(
      calls.filter(({ method }) => method !== "GET").map(({ url, method }) => ({ url, method })),
      [{ url: "https://www.gradescope.com/login", method: "POST" }]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
