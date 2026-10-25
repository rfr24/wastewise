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

/* ---------- a food word describing a container's former contents ---------- */

test('a salad clamshell is not matched as food scraps', () => {
  // The exact prompt from the bug report. "salad" names what the container
  // held; the object being thrown away is a piece of rigid plastic.
  const q = 'I have a clear plastic clamshell container from a salad, '
    + 'is that recyclable in Evans Hall?';
  const ids = retrieveRules(q).map((r) => r.id);
  assert.ok(!ids.includes('food-scraps'),
    `food-scraps must not match a container question, got: ${ids.join(', ')}`);
  // It reaches the rigid-container rule instead, which is what actually covers it.
  assert.ok(ids.includes('rigid-plastic-container'),
    `expected the rigid-container rule, got: ${ids.join(', ')}`);
  // The stream is conditional on the resin number, so it must never shortcut to
  // a flat "recycling" via the zero-token fast path.
  const fast = tryFastPath(q);
  assert.ok(!fast || fast.recommendation === 'unknown',
    'a conditional container must not take the fast path to a bin');
});

/* ---------- the rigid container answers both branches ---------- */

test('a rigid plastic container is answered conditionally, not with a question', () => {
  const rule = ruleById('rigid-plastic-container');
  assert.equal(rule.verification_status, 'verified');
  assert.equal(rule.stream, 'recycling');
  // Conditional keeps it out of the fast path, so the conditions are always stated.
  assert.equal(rule.conditional, true);
  // Both branches must be present in the guidance the model is handed.
  assert.match(rule.guidance, /#1, #2 (and|or) #5/);
  assert.match(rule.guidance, /trash/i);
  assert.match(rule.guidance, /do not ask a question/i);
  // The resin number alone must not be presented as sufficient.
  assert.match(rule.guidance, /greasy|contaminant/i);
  // Cites a real Yale source.
  assert.match(rule.source.url, /^https:\/\/recycling\.yale\.edu\//);
});

test('the film rule and the rigid rule stay on opposite sides', () => {
  // Flexible packaging must never reach the rigid rule, and vice versa.
  for (const q of ['empty snack wrapper', 'plastic bag', 'cling film']) {
    assert.ok(!retrieveRules(q).map((r) => r.id).includes('rigid-plastic-container'),
      `"${q}" is film, not a rigid container`);
  }
  for (const q of ['plastic clamshell', 'deli container', 'plastic tub']) {
    assert.ok(!retrieveRules(q).map((r) => r.id).includes('plastic-film-bags'),
      `"${q}" is rigid, not film`);
  }
});

test('the same shape is caught for other containers and foods', () => {
  for (const q of ['where does a salad container go?', 'empty sandwich box',
                   'a tray from a burrito', 'pizza crust box']) {
    assert.ok(!retrieveRules(q).map((r) => r.id).includes('food-scraps'),
      `food-scraps should not match "${q}"`);
  }
});

test('actual food scraps still reach the food rule', () => {
  // The contrasting cases: real food, including food still sitting in packaging.
  for (const q of ['I have leftover salad to throw away', 'where does a banana peel go?',
                   'half-eaten sandwich in a plastic container', 'apple core',
                   'leftover rice and chicken', 'used tea bag']) {
    assert.ok(retrieveRules(q).map((r) => r.id).includes('food-scraps'),
      `food-scraps should match "${q}"`);
  }
});

test('container rules keep their own matches', () => {
  // These share the attributive shape but name the container themselves.
  assert.equal(top('greasy pizza box'), 'pizza-box');
  assert.equal(top('empty snack wrapper'), 'plastic-film-bags');
  // An adjective before a container noun is not a contents word.
  assert.equal(retrieveRules('compostable plate')[0].id, 'compostable-serviceware');
});
