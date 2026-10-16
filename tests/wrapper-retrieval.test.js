import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrieveRules, retrieveScored, retrieveLocationRules } from '../server/services/rules.js';
import {
  buildItemContexts, alignItemResults, enforceVerification, rulesForItem, tryFastPath,
} from '../server/services/assistant.js';

const film = (q) => retrieveRules(q).map((r) => r.id).includes('plastic-film-bags');
const top = (q) => retrieveRules(q)[0]?.id ?? null;

/* ---------------------------------------------------------------------------
   The exact vision descriptions captured from a real iPhone and a real desktop
   for the same scone-and-wrapper photo. The iPhone's wording contained neither
   "wrapper" nor "film", so retrieval returned nothing and the answer could only
   ever be "unknown".
--------------------------------------------------------------------------- */
const IPHONE = { label: 'clear plastic packaging with attached label', material: 'plastic' };
const DESKTOP = { label: 'clear plastic wrapper', material: 'plastic film' };

const visionItem = (v) => ({
  label: v.label, material: v.material, material_certain: true, condition: 'food-soiled',
  reusable_candidate: false, legible_text: null, resin_code: null, count: 1,
  partially_obscured: false, unclear: false,
});

function pipeline(v, modelItem, question = '') {
  const contexts = buildItemContexts({ question, visionItems: [visionItem(v)] });
  const locationRules = retrieveLocationRules(question);
  const rules = rulesForItem(contexts[0], locationRules);
  const aligned = alignItemResults({ items: [modelItem] }, contexts);
  const out = enforceVerification(aligned[0], rules, { searchText: contexts[0].searchText });
  return { out, rules: rules.map((r) => r.id), query: contexts[0].itemText };
}

/** Mirrors the client's headline logic, so these assert what a student sees. */
function headline(item) {
  const DEST = {
    recycling: { label: 'Recycle', likely: 'Likely recycling' },
    trash: { label: 'Trash', likely: 'Likely trash' },
    food_waste: { label: 'Food scraps', likely: 'Likely food scraps' },
    special: { label: 'Special handling' },
    unknown: { label: "Let's narrow it down" },
  };
  let dest = 'unknown';
  let label = null;
  let place = null;
  let provisional = false;
  if (item.recommendation && item.recommendation !== 'unknown') dest = item.recommendation;
  else if (item.hazard_suspected) { dest = 'special'; label = "Don't bin it"; }
  else if (item.observed_action) {
    dest = item.observed_action.destination;
    place = item.observed_action.place;
    provisional = true;
  }
  const meta = DEST[dest] ?? DEST.unknown;
  const base = label
    ?? (item.confidence === 'likely' && meta.likely && !provisional ? meta.likely : meta.label);
  return place ? `${base} — ${place}` : base;
}

/* ---------- the reported failure ---------- */

test("the iPhone's wording reaches the Yale plastic-film rule", () => {
  // This is the exact query the phone produced, and it used to return [].
  const query = 'clear plastic packaging with attached label plastic';
  assert.ok(film(query), 'the film rule must be retrievable without the words "wrapper" or "film"');
  assert.equal(top(query), 'plastic-film-bags');
});

test('both devices now reach the same rule for the same photo', () => {
  const phone = pipeline(IPHONE, {
    index: 1, recommendation: 'trash', confidence: 'likely', needs_clarification: true,
    clarifying_question: 'Is it flexible film or a rigid container?',
    answer: "Put it in the trash if it's flexible plastic film.",
    rule_ids_used: ['plastic-film-bags'], caveats: [],
  });
  const desktop = pipeline(DESKTOP, {
    index: 1, recommendation: 'trash', confidence: 'confirmed',
    answer: 'Put the wrapper in the trash.', rule_ids_used: ['plastic-film-bags'], caveats: [],
  });

  assert.deepEqual(phone.rules, ['plastic-film-bags']);
  assert.deepEqual(desktop.rules, ['plastic-film-bags']);
  // Neither renders the "narrow it down" placeholder any more.
  assert.equal(headline(phone.out), 'Likely trash');
  assert.equal(headline(desktop.out), 'Trash');
  assert.notEqual(headline(phone.out), "Let's narrow it down");
});

test('ambiguous packaging is provisional, not confirmed', () => {
  // "packaging" alone could be a rigid container, so a confident claim is wrong.
  const { out } = pipeline(IPHONE, {
    index: 1, recommendation: 'trash', confidence: 'confirmed', needs_clarification: true,
    clarifying_question: 'Is it flexible film or a rigid container?',
    answer: 'Trash.', rule_ids_used: ['plastic-film-bags'], caveats: [],
  });
  assert.equal(out.confidence, 'likely', 'a pending clarification caps confidence');
  assert.equal(out.recommendation, 'trash', 'but the provisional answer stands');
  assert.equal(out.clarification_optional, true);
});

test('an unresolved packaging description still asks rather than guessing', () => {
  const { out } = pipeline(IPHONE, {
    index: 1, recommendation: 'unknown', confidence: 'uncertain', needs_clarification: true,
    clarifying_question: 'Is it flexible film or a rigid container?',
    answer: "I can't tell the form from the photo.",
    rule_ids_used: ['plastic-film-bags'], caveats: [],
  });
  assert.equal(out.recommendation, 'unknown');
  assert.equal(headline(out), "Let's narrow it down");
});

/* ---------- flexible vs rigid stays intact ---------- */

test('flexible phrasings a vision pass might use all reach the rule', () => {
  for (const q of ['plastic packaging', 'clear plastic covering', 'plastic pouch',
                   'cellophane wrapping', 'soft plastic sleeve', 'snack packet',
                   'clear plastic wrapper', 'chip bag', 'cling film']) {
    assert.ok(film(q), `${q} should reach the film rule`);
  }
});

test('rigid plastic is never answered as film', () => {
  for (const q of ['rigid plastic takeout container', 'plastic tub', 'clear plastic clamshell',
                   'hard plastic container', 'plastic food container']) {
    assert.ok(!film(q), `${q} must not be answered as film`);
  }
  // Rigid items that have their own rule still reach it.
  assert.equal(top('plastic bottle'), 'plastic-bottle-empty');
});

test('paper and foil packaging are not answered as plastic film', () => {
  for (const q of ['paper wrapper', 'paper bag', 'foil wrapper', 'foil packaging',
                   'aluminum foil']) {
    assert.ok(!film(q), `${q} must not be answered as film`);
  }
});

test('the rule itself forbids a confirmed answer on bare "packaging"', () => {
  const rules = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url), 'utf8'));
  const r = rules.rules.find((x) => x.id === 'plastic-film-bags');
  assert.equal(r.verification_status, 'verified');
  assert.equal(r.stream, 'trash');
  assert.match(r.guidance, /FLEXIBILITY DECIDES THIS RULE/);
  // Bare "packaging" with no observed form is asked about, not assumed.
  assert.match(r.guidance, /form = unknown: ask whether it is flexible film/);
  assert.match(r.guidance, /form = rigid: this rule does NOT apply/);
  // Rigid forms are excluded by data, not just by prose.
  for (const term of ['rigid', 'clamshell', 'tub', 'takeout container']) {
    assert.ok(r.disqualifiers.includes(term), `${term} should disqualify the film rule`);
  }
});

/* ---------- a label stuck to a wrapper is part of it ---------- */

test('an attached label does not become its own item', () => {
  const vision = readFileSync(new URL('../server/services/vision.js', import.meta.url), 'utf8');
  assert.match(vision, /MERGE, DON'T SPLIT/);
  assert.match(vision, /label, sticker, receipt or printed tag/i);
  // And the label wording does not pull in a paper rule.
  const ids = retrieveRules('clear plastic packaging with attached label plastic');
  assert.ok(!ids.some((r) => ['clean-paper', 'paper-plate', 'paper-towel'].includes(r.id)),
    'an attached label must not route the wrapper to a paper rule');
});

/* ---------- safeguards unchanged ---------- */

test('the fast path still refuses ambiguous packaging', () => {
  // A conditional rule must not be answered without the model seeing it.
  assert.equal(tryFastPath('clear plastic packaging with attached label'), null);
  assert.equal(tryFastPath('plastic packaging'), null);
});

test('hazard and conflict protections are untouched', () => {
  const { out } = pipeline({ label: 'lithium battery', material: 'metal' }, {
    index: 1, recommendation: 'trash', confidence: 'confirmed', answer: 'Bin it.',
    rule_ids_used: ['batteries'], caveats: [],
  });
  assert.equal(out.hazard_suspected, true);
  assert.notEqual(out.recommendation, 'trash');
  assert.equal(headline(out), 'Special handling');

  const ids = retrieveRules("compostable fork at Charley's Place").map((r) => r.id);
  assert.ok(ids.includes('charleys-compostable-signage'));
  assert.ok(ids.includes('compostable-serviceware'));
});

test('generic material words still cannot carry a match on their own', () => {
  // "plastic" alone must not retrieve the film rule.
  const scored = retrieveScored('plastic');
  assert.ok(!scored.some((s) => s.rule.id === 'plastic-film-bags' && s.specific),
    'a bare material word is not a specific match');
});
