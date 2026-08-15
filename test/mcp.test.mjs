import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/mcp-server.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function connected(api) {
  const server = createServer(api);
  const client = new Client({ name: "gradescope-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function closeConnection({ client, server }) {
  await client.close();
  await server.close();
}

test("registers the five production tools plus temporary course diagnostics", async () => {
  const connection = await connected({ fetchPage: async () => fixture("account.html") });
  try {
    const result = await connection.client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      [
        "diagnose-course",
        "get-submission",
        "list-assignments",
        "list-courses",
        "list-regrade-requests",
        "list-submissions",
      ]
    );
    for (const tool of result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.annotations?.idempotentHint, true, tool.name);
      assert.ok(tool.outputSchema, `${tool.name} must publish an output schema`);
    }

    const assignmentTool = result.tools.find((tool) => tool.name === "list-assignments");
    assert.equal(assignmentTool.inputSchema.properties.course_id.pattern, "^\\d+$");
    const diagnosticTool = result.tools.find((tool) => tool.name === "diagnose-course");
    assert.equal(diagnosticTool.inputSchema.properties.course_id.pattern, "^\\d+$");
  } finally {
    await closeConnection(connection);
  }
});

test("lists only student courses and uses the student dashboard for assignments", async () => {
  const calls = [];
  const api = {
    fetchPage: async (path) => {
      calls.push(path);
      if (path === "/account") return fixture("account.html");
      if (path === "/courses/101") return fixture("assignments.html");
      throw new Error(`unexpected path ${path}`);
    },
  };
  const connection = await connected(api);
  try {
    const courses = await connection.client.callTool({
      name: "list-courses",
      arguments: {},
    });
    assert.deepEqual(
      courses.structuredContent.courses.map((course) => course.course_id),
      ["101", "102"]
    );

    const assignments = await connection.client.callTool({
      name: "list-assignments",
      arguments: { course_id: "101" },
    });
    assert.equal(assignments.structuredContent.assignments.length, 4);
    assert.deepEqual(calls, ["/account", "/account", "/courses/101"]);
  } finally {
    await closeConnection(connection);
  }
});

test("rejects instructor courses before accessing course data", async () => {
  const calls = [];
  const connection = await connected({
    fetchPage: async (path) => {
      calls.push(path);
      return fixture("account.html");
    },
  });
  try {
    const result = await connection.client.callTool({
      name: "list-submissions",
      arguments: { course_id: "999", assignment_id: "201" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Student Courses/);
    assert.deepEqual(calls, ["/account"]);
  } finally {
    await closeConnection(connection);
  }
});

test("returns structured submissions, submission details, and regrade requests", async () => {
  const api = {
    fetchPage: async (path) => {
      if (path === "/account") return fixture("account.html");
      if (path === "/courses/101/assignments/201/submissions") {
        return fixture("submissions.html");
      }
      if (path === "/courses/101/assignments/201/submissions/301") {
        return fixture("submission-detail.html");
      }
      if (path === "/courses/101/assignments/201/regrade_requests") {
        return fixture("regrades.html");
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  const connection = await connected(api);
  try {
    const submissions = await connection.client.callTool({
      name: "list-submissions",
      arguments: { course_id: "101", assignment_id: "201" },
    });
    assert.equal(submissions.structuredContent.submissions.length, 2);

    const detail = await connection.client.callTool({
      name: "get-submission",
      arguments: { course_id: "101", assignment_id: "201", submission_id: "301" },
    });
    assert.equal(detail.structuredContent.submission.questions.length, 2);

    const regrades = await connection.client.callTool({
      name: "list-regrade-requests",
      arguments: { course_id: "101", assignment_id: "201" },
    });
    assert.equal(regrades.structuredContent.regrade_requests.length, 3);
  } finally {
    await closeConnection(connection);
  }
});
