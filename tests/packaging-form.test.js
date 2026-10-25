import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrieveLocationRules } from '../server/services/rules.js';
import { identificationToQuery } from '../server/services/vision.js';
import {
  buildItemContexts, alignItemResults, enforceVerification, rulesForItem,
} from '../server/services/assistant.js';

const vision = readFileSync(new URL('../server/services/vision.js', import.meta.url), 'utf8');
const assistant = readFileSync(new URL('../server/services/assistant.js', import.meta.url), 'utf8');

/* The exact vision output captured from the iPhone, plus the form field. */
const IPHONE = {
  label: 'clear plastic packaging with attached label',
  material: 'plastic', material_certain: true, condition: 'food-soiled',
  reusable_candidate: false, legible_text: null, resin_code: null, count: 1,
  partially_obscured: false, unclear: false,
};
const item = (extra = {}) => ({ ...IPHONE, form: 'unknown', ...extra });

function pipeline(visionItem, modelItem, question = '') {
  const contexts = buildItemContexts({ question, visionItems: [visionItem] });
  const rules = rulesForItem(contexts[0], retrieveLocationRules(question));
  const aligned = alignItemResults({ items: [modelItem] }, contexts);
  return {
    out: enforceVerification(aligned[0], rules, { searchText: contexts[0].searchText }),
    rules: rules.map((r) => r.id),
    query: contexts[0].itemText,
  };
}

/** Mirrors the client's headline logic — asserts what a student sees. */
function headline(it) {
  const DEST = {
    recycling: { label: 'Recycle', likely: 'Likely recycling' },
    trash: { label: 'Trash', likely: 'Likely trash' },
    food_waste: { label: 'Food scraps', likely: 'Likely food scraps' },
    special: { label: 'Special handling' },
    unknown: { label: "Let's narrow it down" },
  };
  let dest = 'unknown'; let label = null; let place = null; let provisional = false;
  if (it.recommendation && it.recommendation !== 'unknown') dest = it.recommendation;
  else if (it.hazard_suspected) { dest = 'special'; label = "Don't bin it"; }
  else if (it.observed_action) {
    dest = it.observed_action.destination; place = it.observed_action.place; provisional = true;
  }
  const meta = DEST[dest] ?? DEST.unknown;
  const base = label
    ?? (it.confidence === 'likely' && meta.likely && !provisional ? meta.likely : meta.label);
  return place ? `${base} — ${place}` : base;
}

/* ---------- the handoff that was missing ---------- */

test('the vision pass can report form separately from material', () => {
  assert.match(vision, /"form": "flexible_film \| rigid \| unknown"/);
  assert.match(vision, /FORM IS SEPARATE FROM MATERIAL/);
  // Only the pass that sees the photo may judge it.
  assert.match(vision, /you are the only pass that sees the photo/);
  assert.match(vision, /Do not answer "flexible_film" just because something is plastic/);
  // Unrecognised values collapse to unknown rather than being trusted.
  assert.match(vision, /\['flexible_film', 'rigid'\]\.includes\(it\.form\)/);
});

test('the reasoning pass is told the observed form', () => {
  assert.match(assistant, /packaging form \(observed from the photo\)/);
});

test('form travels into retrieval as plain words', () => {
  assert.match(identificationToQuery(item({ form: 'flexible_film' })), /flexible plastic film/);
  assert.match(identificationToQuery(item({ form: 'rigid' })), /rigid container/);
  assert.doesNotMatch(identificationToQuery(item({ form: 'unknown' })), /flexible|rigid/);
});

/* ---------- the iPhone case, end to end ---------- */

test('the iPhone wrapper, seen as flexible film, is trash', () => {
  const r = pipeline(item({ form: 'flexible_film' }), {
    index: 1, recommendation: 'trash', confidence: 'confirmed',
    answer: 'Put the wrapper in the trash.', rule_ids_used: ['plastic-film-bags'], caveats: [],
  });
  assert.deepEqual(r.rules, ['plastic-film-bags']);
  assert.equal(r.out.recommendation, 'trash');
  assert.equal(headline(r.out), 'Trash');
});

test('an uncertain material caps a flexible-film answer at likely', () => {
  const r = pipeline(item({ form: 'flexible_film', material_certain: false }), {
    index: 1, recommendation: 'trash', confidence: 'likely', needs_clarification: true,
    clarifying_question: 'Is it plastic film, paper or foil?',
    answer: "Put it in the trash if it's plastic film.",
    rule_ids_used: ['plastic-film-bags'], caveats: [],
  });
  assert.equal(r.out.recommendation, 'trash');
  assert.equal(r.out.confidence, 'likely');
  assert.equal(r.out.clarification_optional, true, 'the question refines, not blocks');
  assert.equal(headline(r.out), 'Likely trash');
});

test('a rigid container is not answered from the film rule', () => {
  const r = pipeline(item({ form: 'rigid', label: 'clear plastic container' }), {
    index: 1, recommendation: 'trash', confidence: 'confirmed', answer: 'Trash.',
    rule_ids_used: [], caveats: [],
  });
  assert.ok(!r.rules.includes('plastic-film-bags'), 'the film rule must not apply to rigid plastic');
  assert.match(r.query, /rigid container/);
  // A rigid container now has its own verified rule, so the outcome is no longer
  // "unknown" by absence. What must stay true is that the answer comes from the
  // rigid rule and never from the film rule.
  assert.ok(r.rules.includes('rigid-plastic-container'),
    `rigid plastic should be covered by its own rule, got: ${r.rules.join(', ')}`);
});

test('an unknown form still asks rather than guessing', () => {
  const r = pipeline(item({ form: 'unknown' }), {
    index: 1, recommendation: 'unknown', confidence: 'uncertain', needs_clarification: true,
    clarifying_question: 'Is it flexible film, like a wrapper or bag, or a rigid container?',
    answer: "I can't tell the form from the photo.",
    rule_ids_used: ['plastic-film-bags'], caveats: [],
  });
  // The rule is still in play so the model can reason about it...
  assert.deepEqual(r.rules, ['plastic-film-bags']);
  // ...but nothing is asserted.
  assert.equal(r.out.recommendation, 'unknown');
  assert.equal(headline(r.out), "Let's narrow it down");
  assert.match(r.out.clarifying_question, /flexible film|rigid/i);
});

test('a clearly flexible snack wrapper is straightforwardly trash', () => {
  const r = pipeline(
    item({ label: 'snack wrapper', material: 'plastic film', form: 'flexible_film' }),
    { index: 1, recommendation: 'trash', confidence: 'confirmed', answer: 'Trash.',
      rule_ids_used: ['plastic-film-bags'], caveats: [] },
  );
  assert.deepEqual(r.rules, ['plastic-film-bags']);
  assert.equal(headline(r.out), 'Trash');
});

test('paper and foil packaging never reach the plastic rule', () => {
  for (const [label, material] of [['paper wrapper', 'paper'], ['foil packaging', 'aluminium foil']]) {
    const r = pipeline(item({ label, material, form: 'flexible_film' }), {
      index: 1, recommendation: 'trash', confidence: 'confirmed', answer: 'Trash.',
      rule_ids_used: [], caveats: [],
    });
    assert.ok(!r.rules.includes('plastic-film-bags'), `${label} must not use the film rule`);
  }
});

/* ---------- the rule no longer asks for evidence it cannot see ---------- */

test('the rule keys off the reported form, not invisible visual cues', () => {
  const rules = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url), 'utf8'));
  const g = rules.rules.find((r) => r.id === 'plastic-film-bags').guidance;
  assert.match(g, /form = flexible_film/);
  assert.match(g, /form = rigid/);
  assert.match(g, /form = unknown/);
  assert.match(g, /you cannot see the photo yourself/);
  // The old instruction asked the reasoning pass to judge the picture.
  assert.ok(!/crinkled|draped|moulded base/.test(g),
    'the rule must not ask the reasoning pass to assess visual detail');
  // Typed questions, which have no form line, still work.
  assert.match(g, /For a TYPED question with no photo/);
});

/* ---------- safeguards ---------- */

test('hazards and unverified collection practices are unaffected', () => {
  const haz = pipeline(
    { ...item({ form: 'unknown' }), label: 'lithium battery', material: 'metal' },
    { index: 1, recommendation: 'trash', confidence: 'confirmed', answer: 'Bin it.',
      rule_ids_used: ['batteries'], caveats: [] },
  );
  assert.equal(haz.out.hazard_suspected, true);
  assert.notEqual(haz.out.recommendation, 'trash');

  const food = pipeline(
    { ...item({ form: 'unknown' }), label: 'half-eaten scone', material: 'food' },
    { index: 1, recommendation: 'food_waste', confidence: 'confirmed', answer: 'Compost it.',
      rule_ids_used: ['food-scraps'], caveats: [] },
  );
  // An unverified local collection can never read as confirmed...
  assert.notEqual(food.out.confidence, 'confirmed', 'Evans Hall collection stays unverified');
  // ...so it is presented provisionally rather than as settled Yale guidance.
  assert.equal(headline(food.out), 'Likely food scraps');
});
