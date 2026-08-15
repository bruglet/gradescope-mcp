import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnoseSubmissionPage } from "../dist/temporary-submission-diagnostics.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/mcp-server.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function connected(api) {
  const server = createServer(api);
  const client = new Client({ name: "gradescope-submission-diagnostics-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function closeConnection({ client, server }) {
  await client.close();
  await server.close();
}

test("diagnoses live question groups without returning raw page content", () => {
  const result = diagnoseSubmissionPage(
    fixture("submission-detail-live.html"),
    "101",
    "201",
    "301",
    "/courses/101/assignments/201/submissions/301"
  );

  assert.equal(result.parser.current_question_count, 2);
  assert.equal(result.discovery.selectors.question_group, 2);
  assert.equal(result.discovery.selectors.weight_and_score, 3);
  assert.equal(result.discovery.question_groups.total_count, 2);
  assert.deepEqual(
    result.parser.current_question_scores.items.map((question) => ({
      name: question.name,
      score: question.score,
      max_score: question.max_score,
    })),
    [
      { name: "Question 1", score: 12, max_score: 20 },
      { name: "Question 2", score: 20, max_score: 20 },
    ]
  );
  assert.match(result.warnings.join("\n"), /rubric-markup-absent/);
  assert.equal(JSON.stringify(result).includes("submissionOutlineQuestion--weightAndScore-child"), false);
});

test("recognizes script-only question markers without exposing script values", () => {
  const result = diagnoseSubmissionPage(
    fixture("submission-diagnostic-script-data.html"),
    "101",
    "201",
    "301",
    "/courses/101/assignments/201/submissions/301"
  );

  assert.equal(result.parser.current_question_count, 0);
  assert.equal(result.page.scripts.json_count, 1);
  assert.equal(result.page.scripts.question_marker_script_count, 1);
  assert.match(result.warnings.join("\n"), /rendered-or-embedded-data-possible/);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("csrf-secret-value-must-not-appear"), false);
  assert.equal(serialized.includes("student@example.edu"), false);
  assert.equal(serialized.includes("0123456789abcdef"), false);
});

test("recognizes a returned login page without exposing credentials or CSRF values", () => {
  const result = diagnoseSubmissionPage(
    fixture("submission-diagnostic-login.html"),
    "101",
    "201",
    "301",
    "/courses/101/assignments/201/submissions/301"
  );

  assert.equal(result.page.login_page.detected, true);
  assert.equal(result.page.login_page.csrf_field_present, true);
  assert.match(result.warnings.join("\n"), /authentication-page/);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("csrf-secret-value-must-not-appear"), false);
  assert.equal(serialized.includes("password-must-not-appear"), false);
  assert.equal(serialized.includes("student@example.edu"), false);
});

test("diagnose-submission uses the owned detail path and rejects unknown submissions", async () => {
  const calls = [];
  const api = {
    fetchPage: async (path) => {
      calls.push(path);
      if (path === "/account") return fixture("account.html");
      if (path === "/courses/101") return fixture("course-submission-links.html");
      if (path === "/courses/101/assignments/201/submissions/301") {
        return fixture("submission-detail-live.html");
      }
      if (path === "/courses/101/assignments/201/submissions") {
        throw new Error("the bare submissions index must not be requested");
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  const connection = await connected(api);
  try {
    const diagnostic = await connection.client.callTool({
      name: "diagnose-submission",
      arguments: { course_id: "101", assignment_id: "201", submission_id: "301" },
    });
    assert.equal(diagnostic.isError, undefined);
    assert.equal(diagnostic.structuredContent.parser.current_question_count, 2);
    assert.deepEqual(calls, [
      "/account",
      "/courses/101",
      "/courses/101/assignments/201/submissions/301",
    ]);

    calls.length = 0;
    const missing = await connection.client.callTool({
      name: "diagnose-submission",
      arguments: { course_id: "101", assignment_id: "201", submission_id: "999" },
    });
    assert.equal(missing.isError, true);
    assert.deepEqual(calls, ["/account", "/courses/101"]);
  } finally {
    await closeConnection(connection);
  }
});
