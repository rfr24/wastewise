import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildItemContexts, alignItemResults, enforceVerification, rulesForItem,
} from '../server/services/assistant.js';
import { retrieveRules, retrieveLocationRules, loadRules } from '../server/services/rules.js';
import { identificationToQuery, MAX_ITEMS } from '../server/services/vision.js';

const ruleById = (id) => loadRules().rules.find((r) => r.id === id);

/** Run a batch of items through the real per-item pipeline, without the model. */
function runItems(visionItems, modelItems, question = '') {
  const contexts = buildItemContexts({ question, visionItems });
  const locationRules = visionItems ? retrieveLocationRules(question) : [];
  const perItemRules = contexts.map((c) =>
    visionItems ? rulesForItem(c, locationRules) : retrieveRules(c.searchText));
  const aligned = alignItemResults({ items: modelItems }, contexts);
  return aligned.map((raw, i) => ({
    ...enforceVerification(raw, perItemRules[i], { searchText: contexts[i].searchText }),
    index: contexts[i].index,
    rules: perItemRules[i],
  }));
}

const vis = (label, extra = {}) => ({
  label, material: null, material_certain: true, condition: 'unknown',
  reusable_candidate: false, legible_text: null, resin_code: null, count: 1,
  partially_obscured: false, unclear: false, unclear_reason: null, ...extra,
});

/* ---------- one item ---------- */

test('a single-item photo still produces exactly one result', () => {
  const out = runItems([vis('paper coffee cup', { material: 'paper' })], [
    { index: 1, recommendation: 'trash', confidence: 'confirmed', answer: 'Trash.',
      rule_ids_used: ['coffee-cup-paper'], caveats: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].recommendation, 'trash');
  assert.equal(out[0].confidence, 'confirmed');
});

test('a text-only question still produces one item with no identification', () => {
  const contexts = buildItemContexts({ question: 'where does a glass jar go' });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].identification, null);
  assert.equal(contexts[0].searchText, 'where does a glass jar go');
});

/* ---------- scenario 1: scone + wrapper ---------- */

test('a scone and its wrapper are rated separately and differently', () => {
  const out = runItems(
    [vis('half-eaten scone', { material: 'food', condition: 'half-eaten' }),
     vis('plastic wrapper', { material: 'flexible plastic film' })],
    [
      { index: 1, recommendation: 'food_waste', confidence: 'uncertain', answer: 'Food waste, but unconfirmed here.',
        rule_ids_used: ['food-scraps'], caveats: [] },
      { index: 2, recommendation: 'trash', confidence: 'confirmed', answer: 'Film plastic goes in the trash.',
        rule_ids_used: ['plastic-film-bags'], caveats: [] },
    ],
  );
  assert.equal(out.length, 2);
  // The scone's local stream is unverified, so it cannot assert a bin...
  assert.equal(out[0].recommendation, 'unknown');
  assert.equal(out[0].sustainability_note !== null, true);
  // ...while the wrapper's verified answer is untouched by its neighbour.
  assert.equal(out[1].recommendation, 'trash');
  assert.equal(out[1].confidence, 'confirmed');
});

test('an ambiguous wrapper keeps its provisional bin and asks as well', () => {
  const out = runItems(
    [vis('wrapper', { material: 'paper or plastic film', material_certain: false, unclear: true })],
    [{ index: 1, recommendation: 'trash', confidence: 'confirmed', needs_clarification: true,
       clarifying_question: 'Is the wrapper paper or plastic film?',
       rule_ids_used: ['plastic-film-bags'], caveats: [] }],
  );
  // Yale's verified exclusion of film supports a provisional answer, so the
  // question refines it rather than replacing it.
  assert.equal(out[0].recommendation, 'trash');
  assert.equal(out[0].confidence, 'likely', 'provisional, never confirmed');
  assert.equal(out[0].clarification_optional, true);
  assert.match(out[0].clarifying_question, /paper or plastic/i);
});

/* ---------- scenario 2: plate + food + utensils ---------- */

test('reusable dishware routes to the tray return, not a bin', () => {
  const r = ruleById('reusable-dishware');
  assert.equal(r.stream, 'return_dishware');
  assert.equal(r.verification_status, 'observational', 'no published Yale dish policy was found');
  assert.match(r.guidance, /tray return/i);

  const out = runItems(
    [vis('ceramic plate', { material: 'ceramic', reusable_candidate: true })],
    [{ index: 1, recommendation: 'return_dishware', confidence: 'confirmed',
       answer: 'Return it to the tray return.', rule_ids_used: ['reusable-dishware'], caveats: [] }],
  );
  assert.equal(out[0].recommendation, 'return_dishware');
  // Observational evidence can never be "confirmed".
  assert.notEqual(out[0].confidence, 'confirmed');
});

test('a reusable item alongside disposables keeps three independent answers', () => {
  const out = runItems(
    [vis('ceramic plate', { material: 'ceramic', reusable_candidate: true }),
     vis('leftover food', { material: 'food', condition: 'food-soiled' }),
     vis('plastic fork', { material: 'plastic', count: 2 })],
    [
      { index: 1, recommendation: 'return_dishware', confidence: 'likely', answer: 'Tray return.',
        rule_ids_used: ['reusable-dishware'], caveats: [] },
      { index: 2, recommendation: 'unknown', confidence: 'uncertain', answer: 'Not confirmed in Evans Hall.',
        rule_ids_used: ['food-scraps'], caveats: [] },
      { index: 3, recommendation: 'trash', confidence: 'confirmed', answer: 'Plastic utensils go in the trash.',
        rule_ids_used: ['utensils-conventional-plastic'], caveats: [] },
    ],
  );
  assert.deepEqual(out.map((i) => i.recommendation), ['return_dishware', 'unknown', 'trash']);
  // One uncertain item must not degrade the two confident ones.
  assert.equal(out[2].confidence, 'confirmed');
});

test('a plate that might be disposable or broken is clarified first', () => {
  const g = ruleById('reusable-dishware').guidance;
  // Ask when the material is unclear or the item is broken...
  assert.match(g, /material is genuinely unclear/i);
  assert.match(g, /broken or chipped/i);
  // ...but not when the material already settles it.
  assert.match(g, /DO NOT ask whether a ceramic plate/i);
  const out = runItems(
    [vis('plate', { material: 'unclear', material_certain: false })],
    [{ index: 1, recommendation: 'return_dishware', confidence: 'likely', needs_clarification: true,
       clarifying_question: 'Is the plate reusable ceramic, or a disposable one?',
       rule_ids_used: ['reusable-dishware'], caveats: [] }],
  );
  assert.equal(out[0].recommendation, 'unknown');
});

/* ---------- hazardous mixed with ordinary ---------- */

test('a hazardous item among ordinary waste is isolated to its own answer', () => {
  const out = runItems(
    [vis('aluminum can', { material: 'aluminum' }),
     vis('lithium battery', { material: 'metal' })],
    [
      { index: 1, recommendation: 'recycling', confidence: 'confirmed', answer: 'Recycle the can.',
        rule_ids_used: ['aluminum-can'], caveats: [] },
      { index: 2, recommendation: 'trash', confidence: 'confirmed',
        answer: 'When in doubt, just put it in the trash.', rule_ids_used: [], caveats: [] },
    ],
  );
  assert.equal(out[0].recommendation, 'recycling');
  assert.equal(out[0].hazard_suspected, false);
  assert.equal(out[1].hazard_suspected, true);
  assert.equal(out[1].safer_default_offered, false);
  assert.doesNotMatch(out[1].answer, /put it in the trash/i);
});

/* ---------- alignment, injection, limits ---------- */

test('model output is aligned to items even when order or indices are wrong', () => {
  const contexts = buildItemContexts({ visionItems: [vis('a'), vis('b'), vis('c')] });
  const aligned = alignItemResults(
    { items: [{ index: 3, answer: 'third' }, { index: 1, answer: 'first' }] }, contexts,
  );
  assert.equal(aligned.length, 3);
  assert.equal(aligned[0].answer, 'first');
  assert.equal(aligned[2].answer, 'third');
  assert.equal(aligned[1].index, 2, 'a missing item still gets a slot');
});

test('a missing item entry degrades safely rather than inventing a bin', () => {
  const out = runItems([vis('mystery object')], [{}]);
  assert.equal(out[0].recommendation, 'unknown');
  assert.equal(out[0].confidence, 'uncertain');
});

test('verification enforcement applies per item, not once per response', () => {
  const out = runItems(
    [vis('glass jar', { material: 'glass' }), vis('banana peel', { material: 'food' })],
    [
      { index: 1, recommendation: 'recycling', confidence: 'confirmed', answer: 'Recycle.',
        rule_ids_used: ['glass'], caveats: [] },
      { index: 2, recommendation: 'food_waste', confidence: 'confirmed', answer: 'Compost it.',
        rule_ids_used: ['food-scraps'], caveats: [] },
    ],
  );
  assert.equal(out[0].confidence, 'confirmed', 'a verified item keeps its confidence');
  assert.notEqual(out[1].confidence, 'confirmed', 'an unverified item is downgraded');
});

test('the vision pass is told to choose subjects, not inventory the room', () => {
  const src = readFileSync(new URL('../server/services/vision.js', import.meta.url), 'utf8');
  assert.equal(MAX_ITEMS, 8);
  assert.match(src, /CHOOSE THE SUBJECTS CAREFULLY/);
  assert.match(src, /cut off at the edge of the frame/i);
  assert.match(src, /Do not assume every visible object is waste/i);
  assert.match(src, /MERGE, DON'T SPLIT/);
  assert.match(src, /partially_obscured/);
});

test('per-item queries do not leak one item into another', () => {
  const contexts = buildItemContexts({
    visionItems: [vis('ceramic plate', { reusable_candidate: true }), vis('plastic fork')],
  });
  assert.doesNotMatch(contexts[0].searchText, /fork/);
  assert.doesNotMatch(contexts[1].searchText, /plate/);
  assert.equal(retrieveRules(contexts[1].searchText)[0].id, 'utensils-conventional-plastic');
});

test('a location caption reaches only the items it is relevant to', () => {
  const question = "I'm at Charley's Place";
  const contexts = buildItemContexts({
    question,
    visionItems: [
      vis('leftover food', { material: 'food' }),
      vis('ceramic plate', { material: 'ceramic', reusable_candidate: true }),
      vis('compostable fork'),
    ],
  });
  const loc = retrieveLocationRules(question);
  const ids = contexts.map((c) => rulesForItem(c, loc).map((r) => r.id));

  // The food gets the cafe's food-scraps signage...
  assert.ok(ids[0].includes('charleys-food-scraps-bin'));
  // ...the plate gets neither signage rule, because a caption is not evidence
  // about a ceramic plate.
  assert.ok(!ids[1].some((id) => id.startsWith('charleys-')), `plate got ${ids[1]}`);
  // ...and the compostable fork still gets its conflict partner.
  assert.ok(ids[2].includes('charleys-compostable-signage'));
  assert.ok(ids[2].includes('compostable-serviceware'));
});

test('retrieval queries describe one object only', () => {
  const contexts = buildItemContexts({
    question: "I'm at Charley's Place",
    visionItems: [vis('ceramic plate'), vis('plastic fork')],
  });
  // The caption is kept for hazard screening but must not drive retrieval.
  assert.doesNotMatch(contexts[0].itemText, /Charley/);
  assert.match(contexts[0].searchText, /Charley/);
});

test('identificationToQuery marks reusable candidates so dishware rules retrieve', () => {
  const q = identificationToQuery(vis('plate', { reusable_candidate: true, material: 'ceramic' }));
  assert.match(q, /reusable dishware/);
  assert.equal(retrieveRules(q)[0].id, 'reusable-dishware');
});

test('a confident but wrong bin on a hazardous item is overridden', () => {
  const out = runItems(
    [vis('lithium battery', { material: 'metal' })],
    [{ index: 1, recommendation: 'recycling', confidence: 'confirmed',
       answer: 'Recycle the battery.', rule_ids_used: ['batteries'], caveats: [] }],
  );
  assert.notEqual(out[0].recommendation, 'recycling');
  assert.equal(out[0].recommendation, 'special');
  assert.ok(out[0].caveats.some((c) => /must not go in a station bin/i.test(c)));
});

test('the alkaline-battery explanation survives hazard scrubbing', () => {
  const out = runItems(
    [vis('AA battery', { material: 'metal' })],
    [{ index: 1, recommendation: 'special', confidence: 'confirmed',
       answer: 'Yale EHS says ordinary alkaline batteries can be disposed of in normal trash, but lithium and rechargeable batteries need EHS collection.',
       rule_ids_used: ['batteries'], caveats: [] }],
  );
  // Explanation of a verified Yale rule is not a fallback and must be kept.
  assert.match(out[0].answer, /alkaline/i);
  assert.equal(out[0].recommendation, 'special');
});

test('a caption identifies the item when the photo holds only one', () => {
  const one = buildItemContexts({
    question: 'this is an empty aluminum soda can',
    visionItems: [vis('cylindrical container', { material: 'metal' })],
  });
  assert.match(one[0].itemText, /aluminum soda can/);
  assert.equal(retrieveRules(one[0].itemText)[0].id, 'aluminum-can');

  // With several items the same caption must not be pinned to any one of them.
  const many = buildItemContexts({
    question: 'this is an empty aluminum soda can',
    visionItems: [vis('cylindrical container'), vis('paper wrapper')],
  });
  assert.doesNotMatch(many[1].itemText, /aluminum soda can/);
});

/* ---------- utensil material discrimination (P1.1) ---------- */

test('a known utensil material retrieves exactly one utensil rule', () => {
  const only = (q) => retrieveRules(q).map((r) => r.id);
  assert.deepEqual(only('plastic fork'), ['utensils-conventional-plastic']);
  assert.deepEqual(only('metal fork'), ['reusable-dishware']);
  assert.deepEqual(only('compostable fork'), ['compostable-serviceware']);
  assert.deepEqual(only('stainless steel spoon'), ['reusable-dishware']);
});

test('an unknown utensil material surfaces the candidates so the app can ask', () => {
  const ids = retrieveRules('fork').map((r) => r.id);
  assert.ok(ids.includes('utensils-conventional-plastic'));
  assert.ok(ids.includes('reusable-dishware'));
  // Compostable requires an explicit compostable label, so it stays out.
  assert.ok(!ids.includes('compostable-serviceware'));
});

test("the Charley's compostable conflict survives the discriminators", () => {
  const ids = retrieveRules("compostable fork at Charley's Place").map((r) => r.id);
  assert.ok(ids.includes('compostable-serviceware'));
  assert.ok(ids.includes('charleys-compostable-signage'));
});

test('a strong phrase match does not drag along weak unrelated rules', () => {
  assert.deepEqual(retrieveRules('plastic water bottle').map((r) => r.id), ['plastic-bottle-empty']);
  assert.deepEqual(retrieveRules('glass jar').map((r) => r.id), ['glass']);
  assert.deepEqual(retrieveRules('banana peel').map((r) => r.id), ['food-scraps']);
});

/* ---------- hazardous override in multi-item responses (P2.5) ---------- */

test('a confidently wrong hazardous bin is overridden among ordinary items', () => {
  const out = runItems(
    [vis('aluminum can', { material: 'aluminum' }),
     vis('lithium battery', { material: 'metal' }),
     vis('glass jar', { material: 'glass' })],
    [
      { index: 1, recommendation: 'recycling', confidence: 'confirmed', answer: 'Recycle the can.',
        rule_ids_used: ['aluminum-can'], caveats: [] },
      { index: 2, recommendation: 'recycling', confidence: 'confirmed',
        answer: 'Recycle the battery with the can.', rule_ids_used: ['batteries'], caveats: [] },
      { index: 3, recommendation: 'recycling', confidence: 'confirmed', answer: 'Recycle the jar.',
        rule_ids_used: ['glass'], caveats: [] },
    ],
  );
  // The battery is overridden to special handling...
  assert.equal(out[1].recommendation, 'special');
  assert.equal(out[1].hazard_suspected, true);
  assert.ok(out[1].caveats.some((c) => /must not go in a station bin/i.test(c)));
  // ...while its ordinary neighbours are untouched.
  assert.deepEqual([out[0].recommendation, out[2].recommendation], ['recycling', 'recycling']);
  assert.equal(out[0].hazard_suspected, false);
  assert.equal(out[2].confidence, 'confirmed');
});

test('an unidentified hazardous item gets special handling, not a bin', () => {
  const out = runItems(
    [vis('unlabeled spray can', { material: 'metal' })],
    [{ index: 1, recommendation: 'trash', confidence: 'confirmed',
       answer: 'Just bin it.', rule_ids_used: [], caveats: [] }],
  );
  assert.ok(['special', 'unknown'].includes(out[0].recommendation));
  assert.equal(out[0].contamination_notice, null);
});

/* ---------- plastic cup lids (P1.2) ---------- */

test('cup lids stay unverified because the guidance is ambiguous', () => {
  const lid = ruleById('cup-lid-plastic');
  assert.equal(lid.verification_status, 'unverified');
  assert.equal(lid.stream, null, 'an unresolved item must not assert a stream');
  // The rule must carry both sides of the ambiguity, not assume cups' rule.
  assert.match(lid.guidance, /containers, tubs & lids/i);
  assert.match(lid.guidance, /no lids, no straws/i);
  assert.match(lid.guidance, /Loose bottle caps/i);
  assert.match(lid.source.citation, /recyclect/i);
});

/* ---------- food scraps anywhere in Evans Hall (P1.3) ---------- */

test('food-scraps guidance names the Charley\'s bin wherever the student is', () => {
  const g = ruleById('food-scraps').guidance;
  assert.match(g, /ALWAYS MENTION THIS/);
  assert.match(g, /tray return/i);
  assert.match(g, /never imply every station has one/i);
  // ...without claiming the collection is verified.
  assert.match(g, /not verified the current collection/i);
});

test('the sustainability note stays limited to food-waste answers', () => {
  const food = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown', answer: 'x', rule_ids_used: ['food-scraps'], caveats: [] },
    [{ id: 'food-scraps', verification_status: 'unverified', category: 'food_waste' }],
    { searchText: 'banana peel' },
  );
  const fork = enforceVerification(
    { confidence: 'confirmed', recommendation: 'trash', answer: 'x', rule_ids_used: ['utensils-conventional-plastic'], caveats: [] },
    [{ id: 'utensils-conventional-plastic', verification_status: 'verified', category: 'foodservice' }],
    { searchText: 'plastic fork' },
  );
  assert.ok(food.sustainability_note);
  assert.equal(fork.sustainability_note, null);
});
