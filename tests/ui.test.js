import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const css = read('styles.css');
const html = read('index.html');

/* ---------- branding and homepage ---------- */

test('the header carries the logo, the name and the campus', () => {
  // Supplied artwork rather than an emoji or a drawn approximation.
  assert.match(html, /<img class="brand-mark" src="logo\.png"/);
  assert.match(html, /brand-name">WasteWise/);
  assert.match(html, /brand-campus">Yale SOM/);
  // The subtitle no longer names Evans Hall.
  assert.match(html, /Know before you throw\./);
  const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('</h1>') + 120);
  assert.doesNotMatch(hero, /Evans Hall/, 'Evans Hall must not be in the main subtitle');
});

test('the homepage reads as a chat assistant with two entry points', () => {
  assert.match(html, /id="entry-ask"[\s\S]*?Ask a question/);
  assert.match(html, /id="entry-photo"[\s\S]*?Snap a photo/);
  // Speech-bubble visual language.
  assert.match(html, /<symbol id="i-chat"/);
  assert.match(html, /use href="#i-chat"/);
  assert.match(html, /<symbol id="i-camera"/);
});

test('example items are retained', () => {
  assert.match(html, /id="examples"/);
  assert.ok((html.match(/class="chip"/g) ?? []).length >= 3);
});

/* ---------- keyboard ---------- */

test('Enter sends and Shift+Enter inserts a newline', () => {
  assert.match(app, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(app, /requestSubmit\(\)/);
  assert.match(app, /e\.preventDefault\(\)/);
  // The hint is shown to the user, not just implemented.
  assert.match(html, /Enter to send/);
  assert.match(html, /Shift \+ Enter/);
});

test('focus states stay visible and controls are labelled', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
  assert.match(html, /aria-label="Add a photo"/);
  assert.match(html, /aria-label="Ask WasteWise"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /class="sr-only"/);
});

/* ---------- photo upload ---------- */

test('the photo preview is hidden until a valid photo is chosen', () => {
  assert.match(html, /id="photo-preview" class="photo-preview" hidden/);
  assert.match(css, /\.photo-preview\[hidden\]\s*\{\s*display:\s*none/);
  // Revealed only inside onload, once a data URL actually exists.
  const onload = app.slice(app.indexOf('reader.onload'), app.indexOf('reader.onerror'));
  assert.match(onload, /photo-preview'\)\.hidden = false/);
  assert.match(onload, /thumb\.src = photoDataUrl/);
});

test('removing or failing to read a photo fully resets the preview', () => {
  assert.match(app, /function clearPhoto\(\)[\s\S]*?hidden = true[\s\S]*?removeAttribute\('src'\)/);
  assert.match(app, /reader\.onerror = \(\) => \{ clearPhoto\(\)/);
  assert.match(app, /photo-remove'\)\.addEventListener\('click', clearPhoto\)/);
});

test('the photo card shows a sized thumbnail, name and remove control', () => {
  assert.match(css, /\.photo-preview img\s*\{[^}]*width: 54px/);
  assert.match(css, /\.photo-preview img\s*\{[^}]*object-fit: cover/);
  assert.match(html, /id="photo-name"/);
  assert.match(html, /id="photo-remove"/);
  // Long filenames must not overflow.
  assert.match(css, /\.photo-name\s*\{[^}]*text-overflow: ellipsis/);
});

test('photo analysis has its own loading state', () => {
  assert.match(app, /Looking at your photo…/);
  assert.match(app, /Checking the Yale rules…/);
  assert.match(css, /\.loading\s*\{/);
  assert.match(css, /\.spinner\s*\{/);
});

test('camera capture and library upload are offered separately', () => {
  // One input opens the rear camera, a second keeps the library reachable —
  // `capture` on a single input hides the library entirely on a phone.
  assert.match(html, /id="photo-camera" accept="image\/\*" capture="environment"/);
  assert.match(html, /id="photo-library"/);
  assert.match(html, /Take photo/);
  assert.match(html, /Choose from library/);
  // `image/*` so iOS offers the photo library rather than only Files.
  assert.match(html, /id="photo-library" accept="image\/\*"/);
  // Desktop never sees the chooser.
  assert.match(app, /pointer: coarse/);
  assert.match(app, /photo-library'\)\.click\(\)/);
  // Client-side guard mirrors the server limits; nothing is uploaded to disk.
  assert.match(app, /MAX_IMAGE_MB = 5/);
  assert.match(app, /readAsDataURL/);
});

test('HEIC is handled with conversion, then a clear explanation', () => {
  assert.match(app, /createImageBitmap/);
  assert.match(app, /toBlob\(ok, 'image\/jpeg'/);
  assert.match(app, /Most Compatible/);
  // Conversion failure must not leave a half-selected photo behind.
  const fn = app.slice(app.indexOf('async function handlePhotoFile'), app.indexOf('for (const id of'));
  assert.match(fn, /clearPhoto\(\);\s*\n\s*return showError/);
});

test('photo controls stay tappable on a phone', () => {
  assert.match(css, /\.photo-remove \{ min-height: 44px/);
  assert.match(css, /\.photo-choice-btn \{[^}]*min-height: 48px/);
});

/* ---------- results: action first ---------- */

test('every destination has a student-facing label and icon', () => {
  for (const [dest, label] of [
    ['recycling', 'Recycle'], ['trash', 'Trash'], ['food_waste', 'Food scraps'],
    ['return_dishware', 'Return dishware'], ['special', 'Special handling'],
  ]) {
    assert.match(app, new RegExp(`${dest}:\\s*\\{[^}]*'${label}'`), `${dest} needs a plain label`);
    assert.match(css, new RegExp(`\\.result-card\\.d-${dest}\\b`), `${dest} needs an accent`);
  }
  // Title case, not shouted caps.
  assert.ok(!app.includes("'RECYCLE'"), 'destination labels should not be all caps');
});

test('the action leads the card, with the explanation below it', () => {
  const card = app.slice(app.indexOf('function renderResult'), app.indexOf('function buildCaveat'));
  // Item name eyebrow, then destination headline, then the one-line instruction.
  assert.ok(card.indexOf('eyebrow') < card.indexOf('action-label'));
  assert.ok(card.indexOf('action-label') < card.indexOf('class="instruction"'),
    'the destination must come before the explanation');
  assert.ok(card.indexOf('class="instruction"') < card.indexOf('renderFoot'),
    'full reasoning must sit below the short instruction');
  assert.match(css, /\.action-label\s*\{[^}]*font-weight: 800/);
  // The headline reads as one phrase: "Food scraps — Charley's Place".
  assert.match(card, /const headline =/);
});

test('reasoning, sources and status live in an expandable footer row', () => {
  assert.match(app, /<details class="more">/);
  // Source summary on the left, details toggle on the right.
  assert.match(app, /foot-src/);
  assert.match(app, /foot-more">More details/);
  assert.match(app, /Source: Evans Hall signage/);
  assert.match(app, /Rules used/);
  assert.match(app, /View the source →/);
  assert.match(css, /\.foot-more\s*\{[^}]*margin-left: auto/);
});

test('technical vocabulary is not shown to students', () => {
  for (const term of ['verification guardrail', 'enforceVerification', 'retrieval',
                      'verification_status"', 'rule_ids_used', 'safer_default']) {
    assert.ok(!app.includes(term), `"${term}" must not appear in the interface`);
  }
  // Status is phrased in plain words instead.
  assert.match(app, /Backed by published Yale guidance/);
  assert.match(app, /Based on signage we photographed/);
});

/* ---------- the safety constraint ---------- */

test('an unsettled result is never dressed up as a confirmed one', () => {
  // Only a real recommendation leads as a confirmed action.
  const resolve = app.slice(app.indexOf('function resolveAction'), app.indexOf('function renderResult'));
  assert.match(resolve, /item\.recommendation !== 'unknown'/);
  // An observed action is always marked provisional, never silently promoted.
  assert.match(resolve, /provisional: true/);
  // ...which forces a visible note saying the collection is unconfirmed.
  assert.match(app, /collection details are still being verified/i);
  // Unknown and provisional outcomes are visually distinct from confirmed ones.
  // Amber field and edge, plus a named caveat heading — visibly not a
  // confirmed answer, without the dashed edge that rendered as broken ticks.
  assert.match(css, /\.result-card\.d-unknown\s*\{[^}]*dashed/);
  assert.match(css, /\.result-card\.d-unknown \.action\s*\{[^}]*--c-open-bg/);
  assert.match(css, /\.result-card\.is-provisional \.action\s*\{[^}]*--c-open/);
  assert.match(css, /\.result-card\.is-provisional \.action\s*\{[^}]*--c-open-bg/);
});

test('a provisional action always carries its note, compactly', () => {
  const caveat = app.slice(app.indexOf('function buildCaveat'), app.indexOf('function renderFoot'));
  // The provisional branch returns before any path that could return null, so
  // an observed-signage answer can never render without its note.
  assert.ok(caveat.indexOf('act.provisional') < caveat.indexOf('return null'));
  assert.match(caveat, /collection details are still being verified/i);
  assert.match(caveat, /Needs special handling/);
  // One line rather than a headed paragraph; the full story is under details.
  assert.match(caveat, /title: null/);
  assert.match(css, /\.caveat\.compact\s*\{/);
  assert.match(app, /caveat compact/);
});

test('hazard warnings and clarifying questions are never hidden behind the toggle', () => {
  const card = app.slice(app.indexOf('function renderResult'), app.indexOf('function buildCaveat'));
  assert.match(card, /clarifying_question/);
  assert.ok(card.indexOf('clarifying_question') < card.indexOf('renderFoot'),
    'the clarifying question must be above the fold, not inside details');
  // SPECIAL HANDLING keeps a loud accent.
  assert.match(css, /\.result-card\.d-special \.action-icon\s*\{[^}]*--c-special/);
  // A possibly-hazardous item leads with the warning even before its type is known.
  const resolve = app.slice(app.indexOf('function resolveAction'), app.indexOf('function renderResult'));
  assert.match(resolve, /item\.hazard_suspected/);
  assert.match(resolve, /DON.T BIN IT/);
  assert.ok(resolve.indexOf('hazard_suspected') < resolve.indexOf('observed_action'),
    'a hazard must outrank an observed action');
});

test('multiple items render as separate scannable cards under a simple heading', () => {
  assert.match(app, /renderResult\(it, multi, caveats\[i\], sharedTitle\)/);
  assert.match(app, /I found \$\{items\.length\} items to sort\./);
  // No long technical summary ahead of the cards.
  assert.ok(!app.includes('data.summary'), 'the model summary should be gone');
  // Each card names its own item in the eyebrow.
  assert.match(app, /class="eyebrow"/);
});

/* ---------- quick guide ---------- */

test('the guide is searchable and filterable by destination', () => {
  assert.match(html, /id="guide-search"/);
  assert.match(html, /id="guide-filters"/);
  for (const key of ['recycling', 'trash', 'food_waste', 'return_dishware', 'special']) {
    assert.match(app, new RegExp(`\\['${key}',`), `${key} needs a filter`);
  }
  assert.match(app, /function setFilter/);
  assert.match(app, /guide-search'\)\.addEventListener\('input', renderGuide\)/);
});

test('guide rows are compact: icon, name, one tip, destination and a chevron', () => {
  assert.match(app, /guide-emoji/);
  assert.match(app, /guide-name/);
  assert.match(app, /guide-tip/);
  assert.match(app, /guide-dest dest-/);
  assert.match(app, /i-chevron/);
  // Rows are divided by hairlines inside one card, not stacked boxes.
  assert.match(css, /\.guide-item \+ \.guide-item\s*\{\s*border-top/);
  // Detail is behind an expander, not in the row.
  assert.match(app, /<details class="guide-item">/);
  assert.match(app, /guide-detail/);
});

test('guide filters are icon tiles with a visible selected state', () => {
  assert.match(app, /\['trash', 'Trash', 'i-trash'\]/);
  assert.match(app, /aria-pressed/);
  assert.match(css, /\.filter\.is-on\s*\{/);
  assert.match(css, /\.filters\s*\{[^}]*grid-template-columns/);
});

test('the guide marks provisional entries without jargon', () => {
  assert.match(app, /provisional = i\.verification_status !== 'verified'/);
  assert.match(app, /STATUS_WORD\[i\.verification_status\]/);
});

test('Evans Hall context lives in a separate About section', () => {
  assert.match(html, /id="panel-about"/);
  assert.match(html, /Waste sorting at Evans Hall/);
  assert.match(app, /function renderAbout/);
  assert.match(app, /about-resources/);
});

/* ---------- visual direction and layout ---------- */

test('the palette keeps dark forest green on a warm off-white', () => {
  assert.match(css, /--green:\s*#0f4d3a/);
  assert.match(css, /--bg:\s*#faf7f1/);
  for (const token of ['--c-recycling', '--c-trash', '--c-food', '--c-dish', '--c-special']) {
    assert.match(css, new RegExp(`${token}:`), `${token} accent missing`);
  }
});

test('the layout is mobile-first and survives a narrow phone', () => {
  assert.match(html, /width=device-width, initial-scale=1/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /max-width: 680px/);
  // Entry cards stack rather than squashing on a narrow screen.
  const narrow = css.slice(css.indexOf('@media (max-width: 420px)'));
  assert.match(narrow, /\.entries\s*\{\s*grid-template-columns: 1fr/);
});

test('animation stays restrained and respects reduced motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok((css.match(/@keyframes/g) ?? []).length <= 2, 'keep decorative animation minimal');
});

/* ---------- conversational follow-ups ---------- */

test('a clarifying question is answered in place, not in the main composer', () => {
  // The reply field lives inside the question block.
  assert.match(app, /<form class="reply" hidden/);
  assert.match(app, /class="reply-input"/);
  assert.match(app, /placeholder="Type your answer…"/);
  assert.match(css, /\.reply\[hidden\]\s*\{\s*display:\s*none/);

  // The old behaviour — stuffing the assistant's question into the composer —
  // must be gone.
  const wire = app.slice(app.indexOf('function wireReplies'), app.indexOf('async function sendFollowUp'));
  assert.ok(!wire.includes('question.value ='), 'must not write into the main composer');
  assert.match(wire, /btn\.hidden = true/);
  assert.match(wire, /form\.hidden = false/);
  assert.match(wire, /input\.focus\(\)/);
});

test('the follow-up carries context the student does not retype', () => {
  const send = app.slice(app.indexOf('async function sendFollowUp'), app.indexOf('function wireFeedback'));
  // Original question + the item + the question asked + their answer.
  assert.match(send, /lastAsk\.question/);
  assert.match(send, /form\.dataset\.item/);
  assert.match(send, /form\.dataset\.q/);
  assert.match(send, /Answering/);
  // Goes through the existing endpoint, text-only — no re-run of the vision pass.
  assert.match(send, /fetch\('\/api\/ask'/);
  assert.ok(!send.includes('image:'), 'a follow-up must not resend the photo');
});

test('the reply field submits on Enter and allows Shift+Enter newlines', () => {
  const wire = app.slice(app.indexOf('function wireReplies'), app.indexOf('async function sendFollowUp'));
  assert.match(wire, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(wire, /form\.requestSubmit\(\)/);
});

test('duplicate follow-up submissions are prevented', () => {
  const send = app.slice(app.indexOf('async function sendFollowUp'), app.indexOf('function wireFeedback'));
  assert.match(send, /if \(!reply \|\| followUpInFlight\) return/);
  assert.match(send, /input\.disabled = true/);
  assert.match(send, /send\.disabled = true/);
  // ...and re-enabled if it fails, so the student is not locked out.
  assert.match(send, /catch[\s\S]*?send\.disabled = false/);
});

test('a follow-up appends the new recommendation to the conversation', () => {
  const send = app.slice(app.indexOf('async function sendFollowUp'), app.indexOf('function wireFeedback'));
  assert.match(send, /renderAnswer\(data\)/);
  // The student's reply joins the transcript, and the answered field retires.
  assert.match(send, /newTurn\('user'/);
  assert.match(send, /form\.remove\(\)/);
});

test('a fixed one-liner never drops the assistant’s fuller explanation', () => {
  const foot = app.slice(app.indexOf('function renderFoot'), app.indexOf('function wireReplies'));
  assert.match(foot, /item\.answer !== shown/);
  assert.match(foot, /The longer answer/);
  assert.match(app, /renderFoot\(item, act\.instruction \?\? item\.answer\)/);
});

test('food scraps uses an apple core, not a leaf', () => {
  assert.match(html, /<symbol id="i-apple-core"/);
  assert.ok(!html.includes('id="i-leaf"'), 'the leaf icon should be gone');
  // Used in both the result cards and the Quick Guide filter.
  assert.match(app, /food_waste:\s*\{[^}]*icon: 'i-apple-core'/);
  assert.match(app, /\['food_waste', 'Food scraps', 'i-apple-core'\]/);
  // Outlined in the same stroke style as the other icons, not a solid fill.
  const sym = /<symbol id="i-apple-core"[\s\S]*?<\/symbol>/.exec(html)[0];
  assert.match(sym, /fill="none" stroke="currentColor"/);
  assert.ok(!sym.includes('fill="currentColor"'), 'should be outlined, not filled');
  assert.equal((sym.match(/stroke-width/g) ?? []).length, 3, 'body, stem and leaf');
});
