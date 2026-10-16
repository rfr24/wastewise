import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const css = read('styles.css');
const html = read('index.html');

/* ---------- P2: mobile photo chooser ---------- */

test('both photo entry points open the chooser, not the camera', () => {
  assert.match(app, /\$\('#entry-photo'\)\.addEventListener\('click', openPhotoSource\)/);
  assert.match(app, /\$\('#photo-btn'\)\.addEventListener\('click', openPhotoSource\)/);
  // Only the explicit "Take photo" button reaches the camera input.
  const open = app.slice(app.indexOf('function openPhotoSource'), app.indexOf("$('#entry-photo')"));
  assert.ok(!open.includes("#photo-camera"), 'the chooser must come first on mobile');
  assert.match(app, /choose-camera'\)\.addEventListener[\s\S]{0,120}photo-camera'\)\.click/);
});

test('the chooser opens rather than toggles, so a second tap cannot close it', () => {
  const open = app.slice(app.indexOf('function openPhotoSource'), app.indexOf("$('#entry-photo')"));
  assert.match(open, /choice\.hidden = false/);
  assert.ok(!open.includes('!choice.hidden'), 'must not toggle');
});

test('camera and library use separate inputs with the right attributes', () => {
  assert.match(html, /id="photo-camera" accept="image\/\*" capture="environment"/);
  assert.match(html, /id="photo-library" accept="image\/\*" hidden/);
  // The library input must not carry capture, or the library is unreachable.
  const lib = /<input[^>]*id="photo-library"[^>]*>/.exec(html)[0];
  assert.ok(!lib.includes('capture'), 'library input must not have capture');
});

test('touch detection has a fallback beyond matchMedia', () => {
  assert.match(app, /maxTouchPoints/);
});

test('validation, limit and HEIC handling survive the rewiring', () => {
  assert.match(app, /MAX_IMAGE_MB = 5/);
  assert.match(app, /ALLOWED_TYPES/);
  assert.match(app, /createImageBitmap/);
  assert.match(app, /Most Compatible/);
  assert.match(app, /function clearPhoto/);
});

/* ---------- P3: conversation history ---------- */

test('questions appear as user bubbles and answers as result cards', () => {
  assert.match(app, /newTurn\('user'/);
  assert.match(app, /newTurn\('assistant'/);
  assert.match(css, /\.turn\.user\s*\{[^}]*align-self: flex-end/);
  assert.match(css, /\.turn\.user\s*\{[\s\S]*?background: var\(--green\)/);
});

test('the conversation accumulates instead of replacing the last answer', () => {
  // Turns are appended to the chat log; nothing overwrites it wholesale.
  assert.match(app, /chat\.append\(el\)/);
  assert.ok(!app.includes("chat.innerHTML = `"), 'answers must not replace the log');
  // The only full reset is the explicit clear control.
  assert.match(app, /clear-chat'\)\.addEventListener[\s\S]{0,160}chat\.innerHTML = ''/);
  assert.match(html, /id="clear-chat"/);
});

test('scrolling to the newest turn is gentle', () => {
  assert.match(app, /function scrollToTurn[\s\S]*?block: 'nearest', behavior: 'smooth'/);
});

test('each answer keeps its own feedback and follow-up field', () => {
  // Handlers are scoped to a turn, not to a single shared element id.
  assert.match(app, /function wireFeedback\(turn, data\)/);
  assert.match(app, /turn\.querySelector\('\.feedback'\)/);
  assert.match(app, /function wireReplies\(turn\)/);
  assert.match(app, /turn\.querySelectorAll\('\.askblock'\)/);
  // The feedback body still posts the query_id of its own answer.
  assert.match(app, /query_id: data\.query_id/);
});

test('duplicate submissions are blocked and loading state is per turn', () => {
  assert.match(app, /if \(\$\('#submit'\)\.disabled\) return;/);
  assert.match(app, /followUpInFlight/);
  assert.match(app, /runLoadingStages\(hadPhoto, loading\)/);
  assert.match(app, /loading\.remove\(\)/);
});

test('the transcript never keeps the uploaded photo', () => {
  // A chip records that a photo was sent; the image itself is not re-displayed.
  assert.match(app, /photo-chip/);
  assert.match(app, /Photo attached/);
  const submit = app.slice(app.indexOf("$('#ask-form').addEventListener('submit'"),
                           app.indexOf('function runLoadingStages'));
  assert.ok(!/newTurn\('user'[\s\S]{0,400}<img/.test(submit), 'no photo in the transcript');
  assert.match(submit, /clearPhoto\(\)/);
});

test('the privacy note reflects the in-memory conversation', () => {
  assert.match(html, /never\s+saved/);
  assert.match(html, /conversation stays in this browser tab only/);
});

/* ---------- P4 + P5: About ---------- */

test('Why WasteWise? is open by default and uses the new copy', () => {
  assert.match(html, /We’ve all experienced it: waste sorting at Evans Hall can be confusing!/);
  assert.match(html, /As your 1Y Sustainability Chair/);
  assert.match(html, /The goal is twofold/);
  // It is a plain block, not a collapsed accordion.
  const why = /<div class="why">[\s\S]*?<\/div>/.exec(html)[0];
  assert.ok(!why.includes('<details'), 'Why WasteWise? must stay expanded');
});

test('the other three sections are collapsible and closed by default', () => {
  const accs = html.match(/<details class="acc">/g) ?? [];
  assert.equal(accs.length, 3);
  assert.ok(!/<details class="acc" open/.test(html), 'they must start closed');
  for (const heading of ['Waste sorting at Evans Hall', 'Yale waste resources',
                         'New Haven and CT waste resources']) {
    assert.ok(html.includes(`<span>${heading}</span>`), `${heading} missing`);
  }
});

test('individual Evans Hall observations expand on their own', () => {
  assert.match(app, /<details class="about-item">/);
  assert.match(app, /about-title/);
  assert.match(css, /\.about-item > summary/);
});

test('accordions use chevrons and stay keyboard and screen-reader friendly', () => {
  assert.match(html, /acc-chev/);
  assert.match(css, /\.acc\[open\] > summary \.acc-chev/);
  // <details>/<summary> is natively focusable and announced; no ARIA bolt-ons needed.
  assert.match(html, /<summary><span>Yale waste resources<\/span>/);
});

test('the New Haven intro uses the new copy and keeps every verified link', () => {
  assert.match(html, /Looking to sort waste beyond Evans Hall\?/);
  assert.match(html, /separate from Yale’s campus waste system/);
  assert.match(html, /local guidelines may differ/);
  for (const host of ['newhavenct.gov', 'recyclect.com', 'portal.ct.gov']) {
    assert.ok(html.includes(host), `${host} link lost`);
  }
});

test('the Sustainability Chairs note is not repeated on the About page', () => {
  const about = html.slice(html.indexOf('id="panel-about"'));
  assert.ok(!/Sustainability Chairs are working/.test(about),
    'the update belongs on relevant answers, not repeated here');
});

test('feedback has its own budget so it cannot exhaust the question limit', async () => {
  const limits = readFileSync(new URL('../server/middleware/limits.js', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8');
  assert.match(limits, /export function feedbackRateLimit/);
  assert.match(routes, /router\.post\('\/feedback', feedbackRateLimit/);
  // Asking still uses the stricter budget.
  assert.match(routes, /router\.post\('\/ask', rateLimit, dailyCap/);
});

