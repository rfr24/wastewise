import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveRules, loadRules } from '../server/services/rules.js';
import {
  enforceVerification, assessHazard, SUSTAINABILITY_NOTE,
} from '../server/services/assistant.js';

const ruleById = (id) => loadRules().rules.find((r) => r.id === id);
const topRule = (q) => retrieveRules(q)[0]?.id ?? null;

/* ---------- 1. conventional plastic utensils ---------- */

test('plastic utensils are verified to trash with a cited authority', () => {
  const r = ruleById('utensils-conventional-plastic');
  assert.equal(r.verification_status, 'verified');
  assert.equal(r.stream, 'trash');
  assert.match(r.source.url, /recyclect\.com/);
  assert.match(r.source.citation, /Plastic plates, bowls & utensils/);
});

test('plastic utensils answer confidently instead of returning unknown', () => {
  assert.equal(topRule('where does a plastic fork go'), 'utensils-conventional-plastic');
  const out = enforceVerification(
    { confidence: 'confirmed', recommendation: 'trash', answer: 'Plastic forks go in the trash.',
      rule_ids_used: ['utensils-conventional-plastic'], caveats: [] },
    [{ id: 'utensils-conventional-plastic', verification_status: 'verified', category: 'foodservice' }],
    { searchText: 'where does a plastic fork go' },
  );
  assert.equal(out.recommendation, 'trash');
  assert.equal(out.confidence, 'confirmed');
});

test('utensil guidance separates recycling eligibility from Evans Hall specifics', () => {
  const g = ruleById('utensils-conventional-plastic').guidance;
  assert.match(g, /general recycling eligibility/i);
  assert.match(g, /not verified Evans-Hall-specific handling/i);
  // The cup/utensil contrast is the thing students get wrong.
  assert.match(g, /cups/i);
  // The Evans Hall caveat must not read as a reason to withhold the stream.
  assert.match(g, /do not withhold the recommendation/i);
});

/* ---------- 2. food scraps at Charley's Place ---------- */

test("the Charley's food-scraps bin is observational and names the tray return", () => {
  const r = ruleById('charleys-food-scraps-bin');
  assert.equal(r.verification_status, 'observational');
  assert.equal(r.stream, null, 'an observed sign is not a verified stream');
  assert.match(r.guidance, /tray return/i);
  assert.match(r.guidance, /leftover food/i);
  assert.match(r.guidance, /NOT independently verified/i);
});

test("the food-scraps bin only surfaces when Charley's Place is named", () => {
  const atCharleys = retrieveRules("where do my banana peels go at Charley's Place").map((r) => r.id);
  assert.ok(atCharleys.includes('charleys-food-scraps-bin'));
  const generic = retrieveRules('where does a banana peel go').map((r) => r.id);
  assert.ok(!generic.includes('charleys-food-scraps-bin'));
});

test('food-waste answers carry the SOM Sustainability Chairs note verbatim', () => {
  const out = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown', answer: 'Not confirmed.',
      rule_ids_used: ['food-scraps'], caveats: [] },
    [{ id: 'food-scraps', verification_status: 'unverified', category: 'food_waste' }],
    { searchText: 'banana peel' },
  );
  assert.equal(out.sustainability_note, SUSTAINABILITY_NOTE);
  assert.match(out.sustainability_note, /SOM Sustainability Chairs are working to confirm/);
});

test('unrelated answers do not carry the sustainability note', () => {
  const out = enforceVerification(
    { confidence: 'confirmed', recommendation: 'recycling', answer: 'Recycle it.',
      rule_ids_used: ['aluminum-can'], caveats: [] },
    [{ id: 'aluminum-can', verification_status: 'verified', category: 'containers' }],
    { searchText: 'aluminum can' },
  );
  assert.equal(out.sustainability_note, null);
});

test("the compostable-serviceware conflict still works alongside the new bin rule", () => {
  const ids = retrieveRules("compostable fork at Charley's Place").map((r) => r.id);
  assert.ok(ids.includes('compostable-serviceware'));
  assert.ok(ids.includes('charleys-compostable-signage'));
  const out = enforceVerification(
    { confidence: 'confirmed', recommendation: 'trash', answer: 'Trash.',
      rule_ids_used: ['compostable-serviceware', 'charleys-compostable-signage'], caveats: [] },
    [
      { id: 'compostable-serviceware', verification_status: 'verified', location_conflicts: ['charleys-compostable-signage'] },
      { id: 'charleys-compostable-signage', verification_status: 'observational', conflicts_with: ['compostable-serviceware'] },
    ],
    { searchText: "compostable fork at Charley's Place" },
  );
  assert.notEqual(out.confidence, 'confirmed');
  assert.equal(out.conflict_detected, true);
});

/* ---------- 3. unknown items and contamination ---------- */

test('an unidentified ordinary item may carry the safer-trash reasoning', () => {
  const out = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown',
      answer: 'I cannot identify this. For an unidentified item, trash is usually safer, because the wrong item can contaminate a whole recycling load.',
      rule_ids_used: [], caveats: [] },
    [],
    { searchText: 'weird squishy thing' },
  );
  assert.equal(out.safer_default_offered, true);
  assert.equal(out.hazard_suspected, false);
  // The reasoning survives the fallback scrubber...
  assert.match(out.answer, /contaminate/i);
  // ...but it is never a confirmed classification.
  assert.equal(out.recommendation, 'unknown');
  assert.equal(out.confidence, 'uncertain');
  assert.ok(out.caveats.some((c) => /general advice rather than a Yale rule/i.test(c)));
});

test('hazardous items never receive the safer-trash fallback', () => {
  for (const item of [
    'some kind of old battery', 'a broken laptop charger', 'a bottle of unlabeled chemical',
    'a used syringe', 'an unidentified powder', 'a fluorescent light bulb', 'leftover paint',
  ]) {
    const out = enforceVerification(
      { confidence: 'uncertain', recommendation: 'unknown',
        answer: `I am not sure what this is. When in doubt, just put it in the trash.`,
        rule_ids_used: [], caveats: [] },
      [],
      { searchText: item },
    );
    assert.equal(out.hazard_suspected, true, `${item} must be flagged hazardous`);
    assert.equal(out.safer_default_offered, false, `${item} must not get the trash fallback`);
    assert.doesNotMatch(out.answer, /put it in the trash/i, `${item} trash advice must be stripped`);
  }
});

test('hazard detection also fires from retrieved rules, not just wording', () => {
  assert.equal(
    assessHazard({ searchText: 'this thing', matchedRules: [{ id: 'batteries', category: 'hazardous' }] }),
    true,
  );
  assert.equal(assessHazard({ searchText: 'a paper cup', matchedRules: [] }), false);
  // The model's own caution is always honored.
  assert.equal(assessHazard({ searchText: 'a paper cup', matchedRules: [], modelFlag: true }), true);
});

test('a known item with an unverified local stream still gets no trash fallback', () => {
  // This is the Step 1B behavior — it must not be loosened by the new carve-out,
  // because the item IS identified; only the local stream is unconfirmed.
  const out = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown',
      answer: 'Evans Hall collection is unconfirmed. If there is no food-waste bin, put the peel in the trash.',
      rule_ids_used: ['food-scraps'], caveats: [] },
    [{ id: 'food-scraps', verification_status: 'unverified', category: 'food_waste' }],
    { searchText: 'banana peel in Evans Hall' },
  );
  assert.equal(out.safer_default_offered, false);
  assert.doesNotMatch(out.answer, /put the peel in the trash/i);
});

/* ---------- retrieval correctness ---------- */

test('a short alias does not match inside a longer word', () => {
  // "can" must not match inside "cannot" — this was pulling the aluminum-can
  // rule into unrelated questions and suppressing the unidentified-item path.
  assert.equal(retrieveRules('I cannot tell you more about this foam thing').length, 0);
  assert.equal(retrieveRules('where does an aluminum can go')[0].id, 'aluminum-can');
  // Likewise "lid" must not match inside "solid", nor "jar" inside "jargon".
  assert.equal(retrieveRules('this is a solid block of jargon').length, 0);
});

test('an unidentified non-hazardous item reaches the safer-default path', () => {
  const matched = retrieveRules('I cannot tell you more about this foam thing');
  const out = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown',
      answer: 'I cannot identify it. Trash is generally safer than contaminating a recycling load.',
      rule_ids_used: [], caveats: [] },
    matched,
    { searchText: 'I cannot tell you more about this foam thing' },
  );
  assert.equal(out.safer_default_offered, true);
  assert.match(out.answer, /contaminating/i);
});

/* ---------- deterministic contamination notice ---------- */

test('the contamination notice is fixed wording, not model-generated', async () => {
  const { CONTAMINATION_NOTICE } = await import('../server/services/assistant.js');
  const run = (answer) =>
    enforceVerification(
      { confidence: 'uncertain', recommendation: 'unknown', answer, rule_ids_used: [], caveats: [] },
      [],
      { searchText: 'weird squishy thing' },
    );
  const a = run('I cannot identify this.');
  const b = run('No idea what this is, sorry.');
  assert.equal(a.contamination_notice, CONTAMINATION_NOTICE);
  assert.equal(b.contamination_notice, a.contamination_notice, 'wording must not vary');
  assert.match(a.contamination_notice, /contaminate/i);
  assert.match(a.contamination_notice, /safer choice for ordinary, non-hazardous/i);
  // Still never a confirmed classification.
  assert.equal(a.recommendation, 'unknown');
  assert.equal(a.confidence, 'uncertain');
});

test('hazardous items never receive the contamination notice', () => {
  for (const item of ['an old battery', 'an unlabeled chemical', 'a used syringe', 'a broken laptop']) {
    const out = enforceVerification(
      { confidence: 'uncertain', recommendation: 'unknown', answer: 'Unclear.', rule_ids_used: [], caveats: [] },
      [], { searchText: item },
    );
    assert.equal(out.contamination_notice, null, `${item} must not get the trash notice`);
    assert.equal(out.hazard_suspected, true);
  }
});

test('a correctly classified item gets no contamination notice', () => {
  const out = enforceVerification(
    { confidence: 'confirmed', recommendation: 'trash', answer: 'Trash.',
      rule_ids_used: ['coffee-cup-paper'], caveats: [] },
    [{ id: 'coffee-cup-paper', verification_status: 'verified', category: 'foodservice' }],
    { searchText: 'paper coffee cup' },
  );
  assert.equal(out.contamination_notice, null);
});

/* ---------- don't ask what the card already answers ---------- */

test('an observed action suppresses a redundant location question', () => {
  const out = enforceVerification(
    {
      confidence: 'uncertain', recommendation: 'unknown',
      answer: 'A sign at Charley’s Place lists leftover food.',
      clarifying_question: 'Which station or part of Evans Hall are you at?',
      needs_clarification: true, rule_ids_used: ['food-scraps'], caveats: [],
    },
    [{
      id: 'food-scraps', verification_status: 'unverified', category: 'food_waste',
      observed_action: { destination: 'food_waste', place: 'Charley’s Place' },
    }],
    { searchText: 'banana peel' },
  );
  assert.ok(out.observed_action, 'the usable action must survive');
  assert.equal(out.clarifying_question, null, 'the card already names the bin');
  assert.equal(out.needs_clarification, false);
});

test('a question that actually changes the answer is kept', () => {
  const out = enforceVerification(
    {
      confidence: 'uncertain', recommendation: 'unknown', answer: 'Depends on the lid.',
      clarifying_question: 'Is it a tub lid or a disposable drink-cup lid?',
      needs_clarification: true, rule_ids_used: ['cup-lid-plastic'], caveats: [],
    },
    [{ id: 'cup-lid-plastic', verification_status: 'unverified', category: 'foodservice' }],
    { searchText: 'plastic lid' },
  );
  assert.match(out.clarifying_question, /tub lid/);
  assert.equal(out.needs_clarification, true);
});

test('no fallback location question is injected when an action is available', () => {
  const out = enforceVerification(
    {
      confidence: 'uncertain', recommendation: 'unknown',
      answer: 'Not confirmed. If there is no bin, put it in the trash.',
      rule_ids_used: ['food-scraps'], caveats: [],
    },
    [{
      id: 'food-scraps', verification_status: 'unverified', category: 'food_waste',
      observed_action: { destination: 'food_waste', place: 'Charley’s Place' },
    }],
    { searchText: 'banana peel' },
  );
  // The unsupported trash fallback is still stripped...
  assert.doesNotMatch(out.answer, /put it in the trash/i);
  // ...but it is not replaced with a question the card can already answer.
  assert.equal(out.clarifying_question, null);
  assert.ok(out.observed_action);
});
