import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/mcp-server.js";
import { diagnoseAssignmentPdfPage } from "../dist/temporary-pdf-diagnostics.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function connected(api) {
  const server = createServer(api);
  const client = new Client({ name: "gradescope-pdf-diagnostics-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function closeConnection({ client, server }) {
  await client.close();
  await server.close();
}

test("diagnoses an accepted assignment PDF link without exposing its signed URL", () => {
  const result = diagnoseAssignmentPdfPage(
    fixture("assignment-pdf.html"),
    "101",
    "701"
  );

  assert.equal(result.structure.forms.matching_assignment_count, 1);
  assert.equal(result.structure.dialogs.matching_count, 1);
  assert.equal(result.structure.pdf_like_anchors.total_count, 1);
  assert.equal(result.structure.pdf_like_anchors.scoped_to_assignment_container, 1);
  assert.equal(result.parser.accepted_link, true);
  assert.equal(result.parser.filename, "Reaction_Maze_.pdf");
  assert.equal(result.parser.rejection_reasons.length, 0);
  assert.equal(JSON.stringify(result).includes("fixture-signature"), false);
});

test("identifies a likely JavaScript-rendered modal in raw server HTML", () => {
  const result = diagnoseAssignmentPdfPage(
    fixture("assignment-pdf-no-modal.html"),
    "101",
    "701"
  );

  assert.equal(result.structure.assignment_buttons.matching_count, 1);
  assert.equal(result.structure.forms.matching_assignment_count, 0);
  assert.equal(result.structure.dialogs.matching_count, 0);
  assert.equal(result.parser.accepted_link, false);
  assert.match(result.warnings.join("\n"), /browser-only-modal-possible/);
  assert.match(result.warnings.join("\n"), /script-generated-pdf-possible/);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("csrf-secret-value-must-not-appear"), false);
  assert.equal(serialized.includes("script-value-must-not-appear"), false);
  assert.equal(serialized.includes("student@example.edu"), false);
});

test("reports safety-check failures without returning query values", () => {
  const result = diagnoseAssignmentPdfPage(
    fixture("assignment-pdf-rejected.html"),
    "101",
    "701"
  );

  assert.equal(result.parser.accepted_link, false);
  assert.equal(result.structure.pdf_like_anchors.scoped_to_assignment_container, 2);
  assert.match(result.warnings.join("\n"), /pdf-candidate-rejected/);
  assert.ok(
    result.structure.pdf_like_anchors.items.some((anchor) =>
      anchor.rejection_reasons.includes("unexpected-upload-host")
    )
  );
  assert.ok(
    result.structure.pdf_like_anchors.items.some((anchor) =>
      anchor.rejection_reasons.includes("missing-signed-url-parameter")
    )
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("evil-secret-token"), false);
  assert.equal(serialized.includes("X-Amz-Date=fixture"), false);
});

test("diagnose-assignment-pdf uses only the guarded course page path", async () => {
  const calls = [];
  const api = {
    fetchPage: async (path) => {
      calls.push(path);
      if (path === "/account") return fixture("account.html");
      if (path === "/courses/101") return fixture("assignment-pdf.html");
      throw new Error(`unexpected path ${path}`);
    },
  };
  const connection = await connected(api);
  try {
    const result = await connection.client.callTool({
      name: "diagnose-assignment-pdf",
      arguments: { course_id: "101", assignment_id: "701" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.parser.accepted_link, true);
    assert.deepEqual(calls, ["/account", "/courses/101"]);
  } finally {
    await closeConnection(connection);
  }
});

test("diagnose-assignment-pdf fails closed for a non-student course", async () => {
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
      name: "diagnose-assignment-pdf",
      arguments: { course_id: "999", assignment_id: "701" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, ["/account"]);
  } finally {
    await closeConnection(connection);
  }
});
