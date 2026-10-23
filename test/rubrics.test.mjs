import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseHTML } from "node-html-parser";
import { parseSubmissionDetail } from "../dist/html-parser.js";

const fixture = readFileSync(new URL("./fixtures/submission-rubrics.html", import.meta.url), "utf8");
function changedViewer(change) {
  const props = JSON.parse(parseHTML(fixture).querySelector("[data-react-props]").getAttribute("data-react-props"));
  change(props);
  const encoded = JSON.stringify(props).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<div data-react-class="AssignmentSubmissionViewer" data-react-props="${encoded}"></div>`;
}

test("returns each question's categories in display order with explicit applied flags", () => {
  const detail = parseSubmissionDetail(fixture);
  assert.equal(detail.score, 18);
  assert.deepEqual(detail.questions.map(q => q.name), ["Question 1", "Question 2", "Question 3", "Question 4", "Question 5"]);
  const [positive, negative, adjusted, multiple, unknown] = detail.questions;
  assert.equal(positive.scoringType, "positive");
  assert.deepEqual(positive.rubricItems, [
    { description: "Correct", points: 4, applied: false },
    { description: "Partial credit", points: 2, applied: true },
    { description: "Different category with the same points", points: 2, applied: false },
    { description: "", points: 0, applied: false },
  ]);
  assert.equal(negative.scoringType, "negative");
  assert.deepEqual(negative.rubricItems, [
    { description: "Correct", points: 0, applied: false },
    { description: "Missing justification", points: -1, applied: true },
  ]);
  assert.deepEqual(adjusted.scoreAdjustments, [{ points: 1, comment: "Adjustment after review" }]);
  assert.deepEqual(adjusted.comments, ["Adjustment after review", "Comment without a numeric adjustment"]);
  assert.equal(adjusted.maxScore + adjusted.rubricItems.filter(r => r.applied).reduce((sum,r) => sum+r.points,0) + adjusted.scoreAdjustments.reduce((sum,a) => sum+a.points,0), adjusted.score);
  assert.deepEqual(multiple.rubricItems.filter(r => r.applied).map(r => r.points), [1, 2]);
  assert.equal(unknown.scoringType, null);
  assert.deepEqual(unknown.rubricItems, [{ description: "Unknown scoring direction", points: null, applied: true }]);
});

test("does not expose unavailable rubric selections or grading adjustments", () => {
  const hidden = parseSubmissionDetail(changedViewer(p => { p.grades_visible = false; }));
  for (const question of hidden.questions) {
    assert.deepEqual(question.rubricItems, []);
    assert.deepEqual(question.scoreAdjustments, []);
    assert.deepEqual(question.comments, []);
  }
  const hiddenWithHtml = parseSubmissionDetail(
    `<section class="question"><h3 class="question-title">Question 1</h3><div class="rubricItem selected"><div class="description">Hidden category</div><div class="points">2</div></div><div class="comment">Hidden feedback</div></section>` +
    changedViewer(p => { p.grades_visible = false; })
  );
  assert.ok(hiddenWithHtml.questions.every(q => q.rubricItems.length === 0 && q.scoreAdjustments.length === 0 && q.comments.length === 0));
  const missing = parseSubmissionDetail(changedViewer(p => { p.rubric_items = null; }));
  assert.ok(missing.questions.every(q => q.rubricItems.length === 0));
});

test("accepts object-indexed rubric records without confusing equal-valued categories", () => {
  const detail = parseSubmissionDetail(changedViewer(p => {
    p.rubric_items = Object.fromEntries(p.rubric_items.filter(r => r.id !== 1002 || r.description === "Partial credit").map(r => [String(r.id), r]));
  }));
  assert.deepEqual(detail.questions[0].rubricItems.filter(r => r.applied), [{ description: "Partial credit", points: 2, applied: true }]);
  assert.equal(detail.questions[0].rubricItems.length, 4);
});

test("enriches matching HTML questions without dropping viewer rubric data or leaf questions", () => {
  const html = `<section class="question"><h3 class="question-title">Question 1</h3><div class="score">2 / 4</div><div class="comment">HTML feedback</div></section>`;
  const detail = parseSubmissionDetail(html + fixture);
  assert.equal(detail.questions.length, 5);
  assert.equal(detail.questions[0].rubricItems.length, 4);
  assert.deepEqual(detail.questions[0].comments, ["HTML feedback"]);
  assert.equal(detail.questions[2].scoreAdjustments[0].points, 1);
});

test("does not mark an unapplied HTML rubric item selected or invent missing points", () => {
  const html = `<section class="question"><h3 class="question-title">Question 1</h3><div class="score">2 / 4</div><div class="rubricItem unapplied"><div class="description">Unselected category</div><div class="points">4</div></div><div class="rubricItem selected"><div class="description">Selected category</div></div></section>`;
  assert.deepEqual(parseSubmissionDetail(html).questions[0].rubricItems, [
    { description: "Unselected category", points: 4, applied: false },
    { description: "Selected category", points: null, applied: true },
  ]);
});
