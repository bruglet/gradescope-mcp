import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnoseCoursePage } from "../dist/temporary-course-diagnostics.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/mcp-server.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function connected(api) {
  const server = createServer(api);
  const client = new Client({ name: "gradescope-diagnostics-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function closeConnection({ client, server }) {
  await client.close();
  await server.close();
}

test("diagnoses recognized assignment table markup", () => {
  const result = diagnoseCoursePage(fixture("assignments.html"), "101", "CSE 101");

  assert.equal(result.page.login_page.detected, false);
  assert.equal(result.parser.current_assignment_count, 4);
  assert.equal(result.discovery.generic_assignment_link_count, 4);
  assert.equal(result.structure.tables.total_count, 1);
  assert.equal(result.structure.assignment_table_evidence, true);
  assert.equal(result.structure.tables.items[0].rows.total_count, 4);
  assert.deepEqual(result.structure.tables.items[0].rows.items[0].cell_texts.items, [
    "Project 1",
    "Aug 20, 2026 at 11:59 PM",
    "Aug 22, 2026 at 11:59 PM",
    "Submitted",
    "Aug 20, 2026 at 8:10 PM",
    "95 / 100",
  ]);
  assert.deepEqual(result.structure.tables.items[0].heading_labels.items, [
    "Assignment",
    "Due Date",
    "Late Due Date",
    "Status",
    "Submitted At",
    "Score",
  ]);
  assert.equal(result.warnings.length, 0);
});

test("diagnoses assignment-card markup as a parser selector mismatch", () => {
  const result = diagnoseCoursePage(
    fixture("course-assignment-cards.html"),
    "101",
    "CSE 101"
  );

  assert.equal(result.parser.current_assignment_count, 0);
  assert.equal(result.discovery.generic_assignment_link_count, 2);
  assert.equal(result.discovery.unique_assignment_count, 2);
  assert.equal(result.discovery.links.truncated, false);
  assert.deepEqual(
    result.discovery.links.items.map((link) => ({
      assignment_id: link.assignment_id,
      path: link.path,
      label: link.label,
    })),
    [
      { assignment_id: "501", path: "/courses/101/assignments/501", label: "Lab 1" },
      { assignment_id: "502", path: "/courses/101/assignments/502", label: "Lab 2" },
    ]
  );
  assert.ok(result.discovery.links.items[0].ancestors.length >= 3);
  assert.ok(result.structure.card_class_names.items.includes("assignment-card"));
  assert.ok(
    result.structure.card_class_names.items.includes("assignment-card--released")
  );
  assert.ok(result.structure.presence.time_datetime_count >= 1);
  assert.ok(result.structure.presence.status_element_count >= 1);
  assert.ok(result.structure.presence.score_element_count >= 1);
  assert.ok(result.structure.presence.due_date_element_count >= 1);
  assert.ok(result.structure.presence.late_date_element_count >= 1);
  assert.match(result.warnings.join("\n"), /selector-mismatch/);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("student@example.edu"), false);
  assert.equal(serialized.includes("do-not-expose"), false);
  assert.equal(serialized.includes("evil.example"), false);
  assert.equal(serialized.includes("script-value-must-not-appear"), false);
  assert.equal(serialized.includes("hidden-value-must-not-appear"), false);
});

test("recognizes a returned login page without exposing credentials or CSRF values", () => {
  const result = diagnoseCoursePage(fixture("course-login.html"), "101", "CSE 101");

  assert.equal(result.page.login_page.detected, true);
  assert.equal(result.page.login_page.login_form_count, 1);
  assert.equal(result.page.login_page.csrf_field_present, true);
  assert.equal(result.discovery.generic_assignment_link_count, 0);
  assert.match(result.warnings.join("\n"), /authentication-page/);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("csrf-secret-value-must-not-appear"), false);
  assert.equal(serialized.includes("password-must-not-appear"), false);
  assert.equal(serialized.includes("script-secret-must-not-appear"), false);
  assert.equal(serialized.includes("student@example.edu"), false);
});

test("recognizes assignment-shaped rows without links after the parser repair", () => {
  const result = diagnoseCoursePage(
    fixture("course-unlinked-table.html"),
    "101",
    "CSE 101"
  );

  assert.equal(result.parser.current_assignment_count, 2);
  assert.deepEqual(result.parser.current_assignment_ids.items, ["601", "602"]);
  assert.equal(result.discovery.generic_assignment_link_count, 0);
  assert.equal(result.structure.assignment_table_evidence, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.structure.tables.items[0].rows.items.map((row) => ({
      ids: row.numeric_assignment_id_candidates.items,
      paths: row.assignment_path_candidates.items,
    })),
    [
      { ids: ["601"], paths: [] },
      { ids: ["602"], paths: ["/courses/101/assignments/602"] },
    ]
  );
});

test("distinguishes a likely empty course from unexpected markup", () => {
  const empty = diagnoseCoursePage(fixture("course-empty.html"), "101", "CSE 101");
  assert.match(empty.warnings.join("\n"), /valid-empty-course-possible/);

  const unexpected = diagnoseCoursePage(
    fixture("course-unexpected.html"),
    "101",
    "CSE 101"
  );
  assert.match(unexpected.warnings.join("\n"), /unexpected-markup/);
});

test("diagnose-course uses only the guarded course page path", async () => {
  const calls = [];
  const api = {
    fetchPage: async (path) => {
      calls.push(path);
      if (path === "/account") return fixture("account.html");
      if (path === "/courses/101") return fixture("course-assignment-cards.html");
      throw new Error(`unexpected path ${path}`);
    },
  };
  const connection = await connected(api);
  try {
    const result = await connection.client.callTool({
      name: "diagnose-course",
      arguments: { course_id: "101" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.course_id, "101");
    assert.deepEqual(calls, ["/account", "/courses/101"]);
  } finally {
    await closeConnection(connection);
  }
});

test("diagnose-course fails closed for non-student courses before course access", async () => {
  const calls = [];
  const api = {
    fetchPage: async (path) => {
      calls.push(path);
      return fixture("account.html");
    },
  };
  const connection = await connected(api);
  try {
    const result = await connection.client.callTool({
      name: "diagnose-course",
      arguments: { course_id: "999" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Student Courses/);
    assert.deepEqual(calls, ["/account"]);
  } finally {
    await closeConnection(connection);
  }
});
