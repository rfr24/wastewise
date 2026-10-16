import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveRules, retrieveScored, loadRules } from '../server/services/rules.js';
import { tryFastPath } from '../server/services/assistant.js';

const top = (q) => retrieveRules(q)[0]?.id ?? null;
const ruleById = (id) => loadRules().rules.find((r) => r.id === id);

/* ---------- the reported bug ---------- */

test('"paper plate" is not answered as clean office paper', () => {
  // The exact prompt from the bug report.
  assert.equal(top('paper plate'), 'paper-plate');
  const fp = tryFastPath('paper plate');
  assert.ok(fp, 'a specific verified rule may still answer directly');
  assert.equal(fp.candidate.recommendation, 'trash');
  assert.equal(fp.candidate.rule_ids_used[0], 'paper-plate');
  // Phrased as a question too.
  assert.equal(tryFastPath('where does a paper plate go').candidate.recommendation, 'trash');
});

test('paper plates are grounded in Yale guidance, not inference from "paper"', () => {
  const r = ruleById('paper-plate');
  assert.equal(r.verification_status, 'verified');
  assert.equal(r.stream, 'trash');
  assert.match(r.source.citation, /Food service paper/);
  assert.match(r.source.url, /recycling\.yale\.edu/);
  // Covers the variants the report asked about.
  assert.match(r.guidance, /compostable/i);
  assert.match(r.guidance, /clean and empty of food|clean and empty/i);
});

test('paper towels, napkins and tissues are trash, not recycling', () => {
  for (const q of ['paper towel', 'napkin', 'tissue', 'where do paper towels go']) {
    assert.equal(top(q), 'paper-towel', `${q} matched the wrong rule`);
    const fp = tryFastPath(q);
    if (fp) assert.equal(fp.candidate.recommendation, 'trash', `${q} must not be recycling`);
  }
  assert.match(ruleById('paper-towel').source.citation, /Paper towels/);
});

/* ---------- the structural cause ---------- */

test('a bare material word is not a confident match on a generic rule', () => {
  // "paper" alone must not score clean-paper as if the item were named.
  const scored = retrieveScored('paper plate');
  const generic = scored.find((s) => s.rule.id === 'clean-paper');
  assert.ok(!generic || !generic.specific, 'clean-paper must not claim a specific match');
  assert.equal(scored[0].rule.id, 'paper-plate');
  assert.equal(scored[0].specific, true);
});

test('a generic rule can never trigger the fast path', () => {
  assert.equal(ruleById('clean-paper').generic, true);
  // It still answers — through the model, which sees its full guidance.
  assert.equal(top('printer paper'), 'clean-paper');
  assert.equal(tryFastPath('printer paper'), null);
  assert.equal(tryFastPath('office paper'), null);
});

test('the generic paper rule tells the model what it does not cover', () => {
  const g = ruleById('clean-paper').guidance;
  assert.match(g, /CLEAN OFFICE-TYPE PAPER ONLY/);
  assert.match(g, /paper plates/i);
  assert.match(g, /paper towels/i);
});

/* ---------- the other collisions named in the report ---------- */

test('plastic forks and plastic bottles stay distinct', () => {
  assert.equal(top('plastic fork'), 'utensils-conventional-plastic');
  assert.equal(top('plastic bottle'), 'plastic-bottle-empty');
  assert.equal(top('plastic water bottle'), 'plastic-bottle-empty');
});

test('disposable and reusable plates stay distinct', () => {
  assert.equal(top('paper plate'), 'paper-plate');
  assert.equal(top('ceramic plate'), 'reusable-dishware');
  // A plastic plate is ambiguous enough that the model should handle it.
  assert.equal(tryFastPath('plastic plate'), null);
  assert.ok(retrieveRules('plastic plate').some((r) => r.id === 'utensils-conventional-plastic'));
});

test('compostable serviceware stays separate from conventional materials', () => {
  assert.equal(top('compostable fork'), 'compostable-serviceware');
  assert.equal(top('plastic fork'), 'utensils-conventional-plastic');
  // A compostable plate is not routed by the paper-plate rule alone.
  assert.equal(retrieveRules('compostable plate')[0].id, 'compostable-serviceware');
});

test('a common English word in an alias does not match unrelated questions', () => {
  // "can I recycle ..." was scoring the aluminium-can rule.
  assert.equal(top('can I recycle a glass jar'), 'glass');
  assert.equal(top('can I compost a banana peel'), 'food-scraps');
  assert.equal(top('can I recycle this soda can'), 'aluminum-can');
});

/* ---------- safeguards unchanged ---------- */

test("Charley's Place conflict handling is preserved", () => {
  const ids = retrieveRules("compostable fork at Charley's Place").map((r) => r.id);
  assert.ok(ids.includes('compostable-serviceware'));
  assert.ok(ids.includes('charleys-compostable-signage'));
  assert.equal(tryFastPath("compostable fork at Charley's Place"), null);
});

test('hazardous and unverified items still never fast-path', () => {
  for (const q of ['old battery', 'laptop charger', 'banana peel', 'plastic cup lid', 'pizza box']) {
    assert.equal(tryFastPath(q), null, `${q} must go to the model`);
  }
});
