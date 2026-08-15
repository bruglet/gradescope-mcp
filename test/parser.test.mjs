import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAssignmentList,
  parseDashboard,
  parseRegradeRequests,
  parseSubmissionDetail,
  parseSubmissionList,
} from "../dist/html-parser.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("parses student courses and retains roles for fail-closed filtering", () => {
  const courses = parseDashboard(fixture("account.html"));
  assert.deepEqual(
    courses.map(({ id, role, term }) => ({ id, role, term })),
    [
      { id: "101", role: "student", term: "Fall 2026" },
      { id: "102", role: "student", term: "Spring 2026" },
      { id: "999", role: "instructor", term: "Fall 2026" },
    ]
  );
});

test("recognizes the live Your Courses student dashboard without a role heading", () => {
  const courses = parseDashboard(fixture("account-your-courses.html"));
  assert.deepEqual(
    courses.map(({ id, role, term }) => ({ id, role, term })),
    [
      { id: "401", role: "student", term: "Fall 2026" },
      { id: "402", role: "student", term: "Spring 2026" },
    ]
  );
});

test("normalizes assignment dates, states, timestamps, lateness, and scores", () => {
  const assignments = parseAssignmentList(fixture("assignments.html"));
  assert.equal(assignments.length, 4);

  assert.deepEqual(assignments[0], {
    id: "201",
    name: "Project 1",
    type: "unknown",
    dueDate: "2026-08-20T23:59:00-07:00",
    lateDueDate: "2026-08-22T23:59:00-07:00",
    released: true,
    submissionStatus: "submitted",
    statusRaw: "Submitted",
    submitted: true,
    submittedAt: "2026-08-20T20:10:00-07:00",
    late: null,
    lateness: null,
    pointsPossible: 100,
    pointsAwarded: 95,
    url: "/courses/101/assignments/201",
  });

  assert.equal(assignments[1].submissionStatus, "unsubmitted");
  assert.equal(assignments[1].submitted, false);
  assert.equal(assignments[1].dueDate, "Aug 25, 2026 at 11:59 PM");
  assert.equal(assignments[1].lateDueDate, "Aug 27, 2026 at 11:59 PM");

  assert.equal(assignments[2].submissionStatus, "submitted");
  assert.equal(assignments[2].late, true);
  assert.equal(assignments[2].lateness, "Late");
  assert.equal(assignments[3].submissionStatus, "unknown");
  assert.equal(assignments[3].submitted, null);
});

test("parses student dashboard rows with assignment IDs but no links", () => {
  const assignments = parseAssignmentList(
    fixture("assignments-unlinked-table.html"),
    "101"
  );

  assert.equal(assignments.length, 3);
  assert.deepEqual(
    assignments.map((assignment) => ({
      id: assignment.id,
      name: assignment.name,
      dueDate: assignment.dueDate,
      lateDueDate: assignment.lateDueDate,
      submissionStatus: assignment.submissionStatus,
      submitted: assignment.submitted,
      url: assignment.url,
    })),
    [
      {
        id: "701",
        name: "Homework 1",
        dueDate: "2026-09-02T10:00:00-07:00",
        lateDueDate: "2026-09-04T10:00:00-07:00",
        submissionStatus: "unsubmitted",
        submitted: false,
        url: "/courses/101/assignments/701",
      },
      {
        id: "702",
        name: "Lab 2",
        dueDate: "Sep 8 at 11:59PM",
        lateDueDate: null,
        submissionStatus: "submitted",
        submitted: true,
        url: "/courses/101/assignments/702",
      },
      {
        id: "703",
        name: "Worksheet 3",
        dueDate: "Sep 10 at 11:59PM",
        lateDueDate: null,
        submissionStatus: "unsubmitted",
        submitted: false,
        url: "/courses/101/assignments/703",
      },
    ]
  );
});

test("parses multiple student submission attempts", () => {
  const submissions = parseSubmissionList(fixture("submissions.html"));
  assert.equal(submissions.length, 2);
  assert.deepEqual(
    submissions.map((submission) => ({
      id: submission.id,
      submissionStatus: submission.submissionStatus,
      submittedAt: submission.submittedAt,
      late: submission.late,
      lateness: submission.lateness,
      score: submission.score,
      maxScore: submission.maxScore,
    })),
    [
      {
        id: "301",
        submissionStatus: "graded",
        submittedAt: "2026-08-20T20:10:00-07:00",
        late: false,
        lateness: "On time",
        score: 95,
        maxScore: 100,
      },
      {
        id: "302",
        submissionStatus: "submitted",
        submittedAt: "2026-08-22T00:05:00-07:00",
        late: true,
        lateness: "5 minutes late",
        score: 98,
        maxScore: 100,
      },
    ]
  );
});

test("parses submission score, rubric items, comments, and timestamp", () => {
  const detail = parseSubmissionDetail(fixture("submission-detail.html"));
  assert.equal(detail.score, 95);
  assert.equal(detail.maxScore, 100);
  assert.equal(detail.submissionStatus, "graded");
  assert.equal(detail.submittedAt, "2026-08-20T20:10:00-07:00");
  assert.equal(detail.questions.length, 2);
  assert.equal(detail.questions[0].rubricItems[0].applied, true);
  assert.equal(detail.questions[0].comments[0], "Clear explanation.");
});

test("parses known and unknown regrade statuses without fabricating values", () => {
  const requests = parseRegradeRequests(fixture("regrades.html"));
  assert.equal(requests.length, 3);
  assert.equal(requests[0].status, "pending");
  assert.equal(requests[0].response, null);
  assert.equal(requests[1].status, "resolved");
  assert.equal(requests[1].response, "The score was updated.");
  assert.equal(requests[2].status, "unknown");
  assert.equal(requests[2].statusRaw, "Needs instructor review");
});
