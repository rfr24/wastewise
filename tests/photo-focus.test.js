import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  buildItemContexts, alignItemResults, enforceVerification, rulesForItem,
} from '../server/services/assistant.js';
import { retrieveRules, retrieveLocationRules } from '../server/services/rules.js';

const vision = readFileSync(new URL('../server/services/vision.js', import.meta.url), 'utf8');
const assistant = readFileSync(new URL('../server/services/assistant.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const vis = (label, extra = {}) => ({
  label, material: null, material_certain: true, condition: 'unknown',
  reusable_candidate: false, legible_text: null, resin_code: null, count: 1,
  partially_obscured: false, unclear: false, ...extra,
});

function runItems(visionItems, modelItems, question = '') {
  const contexts = buildItemContexts({ question, visionItems });
  const locationRules = visionItems ? retrieveLocationRules(question) : [];
  const perItemRules = contexts.map((c) =>
    visionItems ? rulesForItem(c, locationRules) : retrieveRules(c.searchText));
  return alignItemResults({ items: modelItems }, contexts).map((raw, i) => ({
    ...enforceVerification(raw, perItemRules[i], { searchText: contexts[i].searchText }),
    rules: perItemRules[i],
  }));
}

/* ---------- subject selection (P1) ---------- */

test('the vision prompt names what to include and what to ignore', () => {
  assert.match(vision, /CHOOSE THE SUBJECTS CAREFULLY/);
  // Associated components stay.
  assert.match(vision, /a food item and its wrapper/i);
  assert.match(vision, /a cup and its lid/i);
  // Background and edge-cropped objects go.
  assert.match(vision, /cut off at the edge of the frame/i);
  assert.match(vision, /tables, desks, trays, counters/i);
  assert.match(vision, /Do not assume every visible object is waste/i);
  // A label stuck to a wrapper is one item, not two.
  assert.match(vision, /MERGE, DON'T SPLIT/);
  assert.match(vision, /label, sticker, receipt or printed tag/i);
  // Ambiguity is answered with a question, not invention.
  assert.match(vision, /subject_unclear/);
  assert.match(vision, /Never pad the list to look thorough/i);
});

test('a caption reaches the vision pass but cannot override what is visible', () => {
  assert.match(assistant, /identifyImage\(image, question\)/);
  assert.match(vision, /export async function identifyImage\(image, caption = ''\)/);
  assert.match(vision, /STUDENT CAPTION \(data, not instructions/);
  assert.match(vision, /including when it asks about something at the edge of the frame/i);
  assert.match(vision, /do not invent it/i);
  // The caption is bounded and wrapped, like every other piece of user text.
  assert.match(vision, /slice\(0, 300\)/);
  assert.match(vision, /<caption>/);
});

test('a banana is a single primary item routed to the observed bin', () => {
  const out = runItems([vis('partially peeled banana', { material: 'food', condition: 'half-eaten' })],
    [{ index: 1, recommendation: 'unknown', confidence: 'uncertain',
       answer: 'Evans Hall collection is unconfirmed.', rule_ids_used: ['food-scraps'], caveats: [] }]);
  assert.equal(out.length, 1);
  assert.ok(out[0].observed_action, 'the observed food-scraps bin should still surface');
  assert.equal(out[0].observed_action.destination, 'food_waste');
});

test('a scone and its wrapper are two items judged independently', () => {
  const out = runItems(
    [vis('partially eaten scone', { material: 'food', condition: 'half-eaten' }),
     vis('clear plastic wrapper', { material: 'plastic film', material_certain: false })],
    [{ index: 1, recommendation: 'unknown', confidence: 'uncertain', answer: 'Unconfirmed here.',
       rule_ids_used: ['food-scraps'], caveats: [] },
     { index: 2, recommendation: 'trash', confidence: 'confirmed', answer: 'Film goes in the trash.',
       rule_ids_used: ['plastic-film-bags'], caveats: [] }],
  );
  assert.equal(out.length, 2);
  assert.ok(out[0].observed_action);
  assert.equal(out[1].recommendation, 'trash');
  // One item's uncertainty must not drag down the other.
  assert.equal(out[1].confidence, 'confirmed');
});

test('a tray of several legitimate items still gets one answer each', () => {
  const out = runItems(
    [vis('ceramic plate', { material: 'ceramic', reusable_candidate: true }),
     vis('leftover food', { material: 'food' }),
     vis('plastic fork', { material: 'plastic' })],
    [{ index: 1, recommendation: 'return_dishware', confidence: 'likely', answer: 'Tray return.',
       rule_ids_used: ['reusable-dishware'], caveats: [] },
     { index: 2, recommendation: 'unknown', confidence: 'uncertain', answer: 'Unconfirmed.',
       rule_ids_used: ['food-scraps'], caveats: [] },
     { index: 3, recommendation: 'trash', confidence: 'confirmed', answer: 'Trash.',
       rule_ids_used: ['utensils-conventional-plastic'], caveats: [] }],
  );
  assert.deepEqual(out.map((i) => i.recommendation), ['return_dishware', 'unknown', 'trash']);
});

test('a hazardous item among legitimate subjects is still overridden', () => {
  const out = runItems(
    [vis('scone', { material: 'food' }), vis('lithium battery', { material: 'metal' })],
    [{ index: 1, recommendation: 'unknown', confidence: 'uncertain', answer: 'Unconfirmed.',
       rule_ids_used: ['food-scraps'], caveats: [] },
     { index: 2, recommendation: 'recycling', confidence: 'confirmed', answer: 'Recycle it.',
       rule_ids_used: ['batteries'], caveats: [] }],
  );
  assert.equal(out[1].hazard_suspected, true);
  assert.equal(out[1].recommendation, 'special');
  assert.equal(out[0].hazard_suspected, false);
});

/* ---------- presentation (P3, P4) ---------- */

test('the loading copy no longer implies the request is unusually slow', () => {
  assert.match(app, /'Still working…'/);
  assert.ok(!app.includes('taking longer than usual'), 'the apologetic copy should be gone');
  // Spinner and real error messages survive.
  assert.match(css, /\.spinner\s*\{/);
  assert.match(app, /showError\(err\.message\)/);
});

test('multi-item results lead with a plain count, not a technical summary', () => {
  assert.match(app, /I found \$\{items\.length\} items to sort\./);
  assert.ok(!app.includes('items in this photo'), 'the old heading should be gone');
  assert.ok(!app.includes('data.summary'), 'no model-written summary above the cards');
});

test('a caveat shared by several items is spelled out once', () => {
  const render = app.slice(app.indexOf('function renderAnswer'), app.indexOf('function resolveAction'));
  assert.match(render, /sharedTitle/);
  assert.match(render, /caveat shared/);
  // Each card keeps the heading so uncertainty stays visible on every item.
  assert.match(app, /isShared \? '' : `<p>\$\{esc\(caveat\.body\)\}<\/p>`/);
  assert.match(css, /\.caveat\.terse/);
});

test('deduplicating the caveat does not upgrade an unverified answer', () => {
  // The shared banner is presentation only — recommendation and confidence are
  // untouched by it.
  const render = app.slice(app.indexOf('function renderAnswer'), app.indexOf('function resolveAction'));
  assert.ok(!render.includes('recommendation ='), 'rendering must not rewrite the verdict');
  assert.match(css, /\.result-card\.is-provisional \.action\s*\{[^}]*--c-open-bg/);
});

/* ---------- performance (P5) ---------- */

test('photos are downscaled before upload, with validation intact', () => {
  assert.match(app, /MAX_EDGE = 1600/);
  assert.match(app, /Math\.max\(bitmap\.width, bitmap\.height\) <= MAX_EDGE/);
  assert.match(app, /toBlob\(ok, 'image\/jpeg'/);
  // Limits and format checks still apply afterwards.
  assert.match(app, /MAX_IMAGE_MB = 5/);
  assert.match(app, /ALLOWED_TYPES/);
});

test('the vision JSON stays lean', () => {
  // Free-text fields that cost tokens and were never displayed are gone.
  assert.ok(!vision.includes('unclear_reason'), 'unclear_reason removed');
  assert.ok(!vision.includes('scene_note'), 'scene_note removed');
  assert.match(vision, /max 40 characters/);
  assert.ok(!assistant.includes('"summary"'), 'the summary field is no longer requested');
});

/* ---------- the real photos ---------- */

// Private photos taken on a personal phone. They stay out of the published
// repository, so this check runs locally and skips on a fresh clone.
test('the real iPhone fixtures are present for end-to-end checks', (t) => {
  const files = ['IMG_2558.jpeg', 'IMG_2560.jpeg']
    .map((f) => new URL(`./fixtures/${f}`, import.meta.url));
  if (!files.some(existsSync)) {
    return t.skip('private iPhone fixtures not present in this checkout');
  }
  for (const f of files) assert.ok(existsSync(f), `${f.pathname} missing`);
});

/* ---------- concise student-facing copy ---------- */

test('the answer is one short instruction, not a cited paragraph', () => {
  assert.match(assistant, /"answer": "ONE short sentence/);
  assert.match(assistant, /Do not name your sources in "answer"/);
});

test('internal vocabulary is banned from student-facing copy', () => {
  assert.match(assistant, /NEVER use these words with a student/);
  for (const term of ['rules block', 'knowledge base', 'supplied rules', 'no matching rule']) {
    assert.ok(assistant.includes(term), `${term} should be listed as banned`);
  }
  // And the model is told what to say instead of announcing a missing rule.
  assert.match(assistant, /If you have no rule covering the item, do not announce that/);
});

test('the clarifying question is never printed twice', async () => {
  const { dropRepeatedQuestion } = await import('../server/services/assistant.js');
  assert.equal(
    dropRepeatedQuestion('Put it in the trash. Is the wrapper plastic or paper?',
      'Is the wrapper plastic or paper?'),
    'Put it in the trash.',
  );
  // A genuinely different sentence survives.
  assert.match(
    dropRepeatedQuestion('I cannot tell what this is made of.', 'Is the wrapper plastic or paper?'),
    /cannot tell/,
  );
  // Never strips the whole answer away.
  assert.equal(dropRepeatedQuestion('Is it plastic?', 'Is it plastic?'), 'Is it plastic?');
  assert.match(assistant, /NEVER repeat your clarifying question inside "answer"/);
});

/* ---------- flexible plastic packaging ---------- */

test('a flexible wrapper is answered without demanding a resin number', () => {
  assert.match(assistant, /RESIN NUMBERS ARE FOR RIGID CONTAINERS/);
  assert.match(assistant, /never withhold an answer waiting for one/i);
  const rules = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url), 'utf8'));
  const film = rules.rules.find((r) => r.id === 'plastic-film-bags');
  assert.equal(film.verification_status, 'verified');
  assert.equal(film.stream, 'trash');
  assert.match(film.guidance, /DO NOT ASK FOR A RESIN NUMBER/);
  assert.match(film.guidance, /FLEXIBILITY DECIDES THIS RULE/);
});

test('ordinary flexible packaging reaches the verified film rule', () => {
  for (const q of ['clear plastic wrapper', 'snack wrapper', 'chip bag', 'plastic film sleeve']) {
    assert.equal(retrieveRules(q)[0]?.id, 'plastic-film-bags', `${q} should hit the film rule`);
  }
});

test('materials that are genuinely not film do not claim the film rule', () => {
  for (const q of ['paper wrapper', 'foil wrapper', 'rigid plastic container']) {
    const ids = retrieveRules(q).map((r) => r.id);
    assert.ok(!ids.includes('plastic-film-bags'), `${q} must not be answered as film`);
  }
});

test('a likely-but-uncertain wrapper keeps its stream instead of going unknown', () => {
  const out = runItems(
    [vis('clear plastic wrapper', { material: 'plastic film', material_certain: false })],
    [{ index: 1, recommendation: 'trash', confidence: 'likely',
       answer: 'Put the wrapper in the trash.', rule_ids_used: ['plastic-film-bags'], caveats: [] }],
  );
  assert.equal(out[0].recommendation, 'trash');
  assert.equal(out[0].confidence, 'likely');
});

/* ---------- the compact signage note ---------- */

test('the food-scraps note is one short line in both rules', () => {
  const rules = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url), 'utf8'));
  for (const id of ['food-scraps', 'charleys-food-scraps-bin']) {
    const r = rules.rules.find((x) => x.id === id);
    assert.equal(r.observed_action.caveat,
      'Based on posted signage; collection details are still being verified.');
  }
});

test('the full explanation is still reachable under More details', () => {
  assert.match(app, /The longer answer/);
  assert.match(app, /Rules used/);
  assert.match(app, /View the source →/);
});

/* ---------- leftover food coverage ---------- */

test('common leftover foods reach the food-scraps rule', () => {
  // The vision pass rarely says "banana peel" — it says "partially eaten baked
  // item" or "scone". Those matched nothing, or the small-items rule.
  for (const q of ['scone', 'cookie', 'muffin', 'half-eaten pastry', 'pizza crust',
                   'partially eaten baked item', 'leftover rice', 'banana peel',
                   'crumbled chocolate-chip cookie']) {
    assert.equal(retrieveRules(q)[0]?.id, 'food-scraps', `${q} should reach the food rule`);
  }
});

test('a generic noun does not drag an item into the small-items rule', () => {
  const ids = retrieveRules('partially eaten baked item').map((r) => r.id);
  assert.ok(!ids.includes('small-items'), '"item" must not score the small-items rule');
  // Genuinely small loose things still match it.
  assert.ok(retrieveRules('bottle cap').some((r) => r.id === 'small-items'));
  assert.ok(retrieveRules('straw').some((r) => r.id === 'small-items'));
});

test('broadening food aliases did not disturb neighbouring rules', () => {
  assert.equal(retrieveRules('pizza box')[0].id, 'pizza-box');
  assert.equal(retrieveRules('paper plate')[0].id, 'paper-plate');
  assert.equal(retrieveRules('coffee cup')[0].id, 'coffee-cup-paper');
  assert.equal(retrieveRules('plastic wrapper')[0].id, 'plastic-film-bags');
  assert.equal(retrieveRules('plastic bottle')[0].id, 'plastic-bottle-empty');
});

test('an unresolved material is asked about materially, not by location', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown',
      answer: 'Not sure. If there is no bin, put it in the trash.',
      rule_ids_used: [], caveats: [] },
    [{ id: 'plastic-film-bags', verification_status: 'verified', category: 'plastics' }],
    { searchText: 'rigid plastic takeout container' },
  );
  assert.match(out.clarifying_question, /what is it made of/i);
  assert.doesNotMatch(out.clarifying_question, /which station|part of Evans Hall/i);
});

test('a food item still gets the location question', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { confidence: 'uncertain', recommendation: 'unknown',
      answer: 'Unconfirmed. Otherwise use the trash.', rule_ids_used: [], caveats: [] },
    [{ id: 'food-scraps', verification_status: 'unverified', category: 'food_waste' }],
    { searchText: 'leftover rice' },
  );
  assert.match(out.clarifying_question, /Evans Hall/i);
});

test('a student who cannot identify the material is asked, not told', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { confidence: 'confirmed', recommendation: 'trash', answer: 'Put it in the trash.',
      rule_ids_used: ['plastic-film-bags'], caveats: [] },
    [{ id: 'plastic-film-bags', verification_status: 'verified', category: 'plastics',
       stream: 'trash' }],
    { searchText: 'I have a wrapper but cannot tell what it is made of' },
  );
  assert.notEqual(out.confidence, 'confirmed');
  assert.equal(out.recommendation, 'unknown');
  assert.match(out.clarifying_question, /made of/i);
});

test('a clearly described wrapper is still answered outright', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { confidence: 'confirmed', recommendation: 'trash', answer: 'Put the wrapper in the trash.',
      rule_ids_used: ['plastic-film-bags'], caveats: [] },
    [{ id: 'plastic-film-bags', verification_status: 'verified', category: 'plastics',
       stream: 'trash' }],
    { searchText: 'clear plastic snack wrapper' },
  );
  assert.equal(out.recommendation, 'trash');
  assert.equal(out.confidence, 'confirmed');
  assert.equal(out.clarifying_question, null);
});

/* ---------- provisional answers survive an optional clarification ---------- */

/**
 * Mirrors the client's resolveAction + headline logic, so these tests assert
 * what a student actually SEES. The previous tests only checked the model's
 * raw output, which is why the "Let's narrow it down" mismatch slipped through.
 */
function renderedHeadline(item) {
  const DEST = {
    recycling: { label: 'Recycle', likely: 'Likely recycling' },
    trash: { label: 'Trash', likely: 'Likely trash' },
    food_waste: { label: 'Food scraps', likely: 'Likely food scraps' },
    return_dishware: { label: 'Return dishware', likely: 'Likely return dishware' },
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
  // An observed action carries its own "being verified" note, so it is not
  // additionally prefixed with "Likely".
  const base = label
    ?? (item.confidence === 'likely' && meta.likely && !provisional ? meta.likely : meta.label);
  return place ? `${base} — ${place}` : base;
}

test('a likely flexible wrapper renders as "Likely trash", not "Let\'s narrow it down"', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    {
      recommendation: 'trash', confidence: 'likely', needs_clarification: true,
      clarifying_question: 'Is the wrapper flexible plastic, paper, or foil?',
      answer: "Put it in the trash if it's flexible plastic film.",
      rule_ids_used: ['plastic-film-bags'], caveats: [],
    },
    [{ id: 'plastic-film-bags', verification_status: 'verified', category: 'plastics', stream: 'trash' }],
    { searchText: 'clear plastic wrapper with attached label' },
  );
  // The recommendation survives the question...
  assert.equal(out.recommendation, 'trash');
  assert.equal(out.confidence, 'likely');
  assert.equal(out.clarification_optional, true);
  // ...the question is still offered...
  assert.match(out.clarifying_question, /plastic, paper, or foil/i);
  // ...and this is what the student sees.
  assert.equal(renderedHeadline(out), 'Likely trash');
});

test('an optional clarification never promotes an answer to confirmed', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { recommendation: 'trash', confidence: 'confirmed', needs_clarification: true,
      clarifying_question: 'Plastic or paper?', answer: 'Trash.',
      rule_ids_used: ['plastic-film-bags'], caveats: [] },
    [{ id: 'plastic-film-bags', verification_status: 'verified', category: 'plastics', stream: 'trash' }],
    { searchText: 'wrapper' },
  );
  assert.equal(out.confidence, 'likely', 'an unproven identification cannot be confirmed');
});

test('a genuinely unidentified item stays unresolved', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { recommendation: 'trash', confidence: 'likely', needs_clarification: true,
      clarifying_question: 'What is it?', answer: 'Maybe trash.', rule_ids_used: [], caveats: [] },
    [], { searchText: 'unidentified squishy object' },
  );
  assert.equal(out.recommendation, 'unknown');
  assert.equal(out.clarification_optional, false);
  assert.equal(renderedHeadline(out), "Let's narrow it down");
});

test('an unverified local stream is not rescued by the optional path', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { recommendation: 'food_waste', confidence: 'likely', needs_clarification: true,
      clarifying_question: 'Which station?', answer: 'Food scraps.',
      rule_ids_used: ['food-scraps'], caveats: [] },
    [{ id: 'food-scraps', verification_status: 'unverified', category: 'food_waste', stream: null,
       observed_action: { destination: 'food_waste', place: "Charley's Place" } }],
    { searchText: 'banana peel' },
  );
  // No verified rule names this stream, so it falls back to the observed action.
  assert.equal(out.recommendation, 'unknown');
  assert.equal(out.clarification_optional, false);
  assert.match(renderedHeadline(out), /Food scraps — Charley/);
});

test('a hazardous item is never framed as an optional clarification', async () => {
  const { enforceVerification } = await import('../server/services/assistant.js');
  const out = enforceVerification(
    { recommendation: 'trash', confidence: 'likely', needs_clarification: true,
      clarifying_question: 'What type of battery?', answer: 'Bin it.',
      rule_ids_used: ['batteries'], caveats: [] },
    [{ id: 'batteries', verification_status: 'verified', category: 'hazardous', stream: 'special' }],
    { searchText: 'old battery' },
  );
  assert.equal(out.hazard_suspected, true);
  assert.equal(out.clarification_optional, false);
  assert.notEqual(out.recommendation, 'trash');
  assert.equal(renderedHeadline(out), "Don't bin it");
});

test('the UI distinguishes optional clarifications from blocking ones', () => {
  assert.match(app, /item\.clarification_optional \? ' optional' : ''/);
  assert.match(app, /Not sure\?/);
  assert.match(app, /Optional clarification/);
  assert.match(css, /\.askblock\.optional/);
  // The likely wording exists for every bin stream, but not for hazards.
  assert.match(app, /likely: 'Likely trash'/);
  const dest = app.slice(app.indexOf('const DEST = {'), app.indexOf('const STATUS_WORD'));
  assert.ok(!/special:[^}]*likely:/.test(dest), 'hazards must not be softened to "likely"');
});

test('student-facing copy avoids announcing a missing rule when one applies', () => {
  // The no-rule caveat only fires when nothing matched, and reads plainly.
  assert.ok(!assistant.includes('No Yale rule covers this item'));
  assert.match(assistant, /We don’t have specific guidance for this one/);
});
