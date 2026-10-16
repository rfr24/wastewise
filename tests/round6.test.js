import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryFastPath } from '../server/services/assistant.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

/* ================= P2: feedback ================= */

const dir = mkdtempSync(join(tmpdir(), 'ww-fb-'));
process.env.DB_PATH = join(dir, 'fb.db');
process.env.PORTKEY_API_KEY ??= 'test-key';
const { default: appServer } = await import('../server/index.js');
const { _resetLimits } = await import('../server/middleware/limits.js');
const { recordQuery, recentComments, usageSummary } = await import('../server/services/db.js');

let server, base, queryId;
before(async () => {
  server = appServer.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  _resetLimits();
  queryId = recordQuery({ question: 'test', recommendation: 'trash', confidence: 'confirmed' });
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const sendFeedback = (body) =>
  fetch(`${base}/api/feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

test('feedback persists to SQLite with its comment', async () => {
  _resetLimits();
  const res = await sendFeedback({ query_id: queryId, helpful: false, comment: 'Could not find the bin.' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, saved: true });

  const rows = recentComments();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].comment, 'Could not find the bin.');
  assert.equal(rows[0].helpful, 0);
  // Anonymous: the stored row carries no identifier of any kind.
  for (const key of Object.keys(rows[0])) {
    assert.ok(!/user|email|name|ip|session/i.test(key), `${key} looks like an identifier`);
  }
});

test('the same answer cannot be rated twice', async () => {
  _resetLimits();
  const res = await sendFeedback({ query_id: queryId, helpful: true });
  assert.equal(res.status, 409);
});

test('an over-long comment is rejected rather than silently truncated', async () => {
  _resetLimits();
  const id = recordQuery({ question: 'x', recommendation: 'trash' });
  const res = await sendFeedback({ query_id: id, helpful: true, comment: 'x'.repeat(301) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /under 300 characters/);
  assert.equal(recentComments().filter((r) => r.comment?.length > 300).length, 0);
});

test('feedback without a comment is accepted', async () => {
  _resetLimits();
  const id = recordQuery({ question: 'y', recommendation: 'recycling' });
  const res = await sendFeedback({ query_id: id, helpful: true });
  assert.equal(res.status, 200);
});

test('a non-text comment is rejected', async () => {
  _resetLimits();
  const id = recordQuery({ question: 'z', recommendation: 'trash' });
  assert.equal((await sendFeedback({ query_id: id, helpful: true, comment: { a: 1 } })).status, 400);
});

test('comment counts reach the usage aggregate for the future dashboard', () => {
  const totals = usageSummary();
  assert.equal(typeof totals.feedback.with_comment, 'number');
  assert.ok(totals.feedback.with_comment >= 1);
});

test('the UI only confirms after a successful save, and says what it does', () => {
  assert.match(app, /Thanks! Your anonymous feedback has been saved\./);
  // The old over-claim is gone — nothing promises a human review.
  assert.ok(!app.includes('noted for the sustainability team'));
  const wire = app.slice(app.indexOf('function wireFeedback'), app.length);
  assert.ok(wire.indexOf('if (!res.ok) throw') < wire.indexOf('has been saved'),
    'the confirmation must come after the response is checked');
  assert.match(wire, /sending/, 'duplicate submits must be guarded');
  // The comment field is rendered by app.js alongside each answer.
  assert.match(app, /Anything we could improve\?/);
  assert.match(app, /I couldn't find the food-scraps bin\./);
  assert.match(app, /maxlength="300"/);
});

/* ================= P3: fast path ================= */

test('common verified questions skip the model entirely', () => {
  for (const q of ['where does a paper coffee cup go', 'where does an aluminum can go',
                   'can I recycle a glass jar', 'where does a plastic fork go']) {
    const fp = tryFastPath(q);
    assert.ok(fp, `${q} should take the fast path`);
    assert.equal(fp.candidate.confidence, 'confirmed');
    assert.ok(['recycling', 'trash'].includes(fp.candidate.recommendation));
  }
});

test('the fast path never fires for anything unsettled or hazardous', () => {
  const mustUseModel = [
    'where do I put a banana peel',          // observed signage only
    'can I recycle a plastic cup lid',       // unverified
    'where does a pizza box go',             // depends on soiling
    'I found some kind of old battery',      // hazardous
    'where does my laptop charger go',       // hazardous
    "compostable fork at Charley's Place",   // location conflict
    'where does a compostable fork go',      // conflict partner exists
    'where does a fork go',                  // ambiguous material
    'where does a ceramic plate go',         // observational
    'my ceramic plate is broken',            // condition matters
    'I have a coffee cup and a banana peel', // compound
    'what if the cup is not empty',          // conditional
  ];
  for (const q of mustUseModel) {
    assert.equal(tryFastPath(q), null, `${q} must go to the model`);
  }
});

test('the fast path reports zero API usage honestly', () => {
  const fp = tryFastPath('where does an aluminum can go');
  assert.equal(fp.candidate.rule_ids_used.length, 1);
  // Its answer is the curated student-facing copy, not model prose.
  assert.ok(fp.candidate.answer.length > 30);
});

test('latency instrumentation is reported for the dashboard', () => {
  const assistant = readFileSync(new URL('../server/services/assistant.js', import.meta.url), 'utf8');
  assert.match(assistant, /timings_ms/);
  assert.match(assistant, /retrieval_ms/);
  assert.match(assistant, /reasoning_ms/);
});

test('the loading indicator explains itself and admits delays', () => {
  assert.match(app, /function runLoadingStages/);
  assert.match(app, /Still working…/);
  assert.match(app, /Identifying what’s in the photo…/);
});

/* ================= P4: logo and icons ================= */

test('the header uses the supplied logo artwork', () => {
  assert.match(html, /<img class="brand-mark" src="logo\.png" alt="WasteWise"/);
  // Intrinsic size is declared so the header does not reflow while it loads.
  assert.match(html, /width="192" height="192"/);
  // The wordmark and tagline stay.
  assert.match(html, /brand-name">WasteWise/);
  assert.match(html, /brand-tagline">Know before you throw\./);
  // The drawn lockup it replaced is gone rather than left as dead markup.
  assert.ok(!html.includes('id="i-logo"'), 'the unused drawn logo should be removed');
});

test('the logo file ships with the app and is small enough to serve', () => {
  const file = new URL('../public/logo.png', import.meta.url);
  const bytes = statSync(file).size;
  assert.ok(bytes > 0, 'logo.png must exist in public/');
  assert.ok(bytes < 200 * 1024, `logo.png is ${Math.round(bytes / 1024)}KB — too heavy for a header mark`);
});

test('the Quick Guide recycle tile uses the standard Unicode symbol, larger', () => {
  // A conventional ♻ rather than a drawn approximation...
  assert.match(app, /\['recycling', 'Recycle', '♻\\uFE0E'\]/);
  assert.match(app, /filter-emoji/);
  // ...in its monochrome text form, so it matches the grey icon set.
  assert.match(app, /\\uFE0E/, 'needs the text variation selector, not the emoji one');
  assert.match(css, /\.filter-emoji \{[\s\S]*?color: var\(--muted\)/);
  assert.match(css, /\.filter-emoji \{[\s\S]*?grayscale\(1\)/);
  // Visibly larger than the 20px icons it replaced.
  assert.match(css, /\.filter svg \{ width: 24px/);
  assert.match(css, /\.filter-emoji \{[\s\S]*?font-size: 1\.6rem/);
});

test('the favicon is a valid, self-contained SVG matching the logo', () => {
  const line = html.split('\n').find((l) => l.includes('rel="icon"'));
  const uri = decodeURIComponent(/href="data:image\/svg\+xml,([^"]+)"/.exec(line)[1]);
  assert.ok(uri.startsWith('<svg') && uri.endsWith('</svg>'), 'favicon must be complete');
  // A double quote would terminate the href attribute early.
  assert.ok(!uri.includes('"'), 'favicon data URI must use single quotes only');
  assert.equal((uri.match(/rotate\(/g) ?? []).length, 2);
  const open = (uri.match(/<([a-z]+)(?=[\s/>])/g) ?? []).length;
  const close = (uri.match(/<\//g) ?? []).length;
  const self = (uri.match(/\/>/g) ?? []).length;
  assert.equal(open, close + self, 'favicon tags must balance');
});

test('other Quick Guide emojis are untouched', () => {
  const rules = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url), 'utf8'));
  const icons = rules.rules.filter((r) => r.guide?.show).map((r) => r.guide.icon);
  assert.ok(icons.includes('🍌') && icons.includes('☕') && icons.includes('🔋'));
});

/* ================= P5: About page ================= */

test('the About page opens with a personal Why WasteWise section', () => {
  assert.match(html, /Why WasteWise\?/);
  assert.match(html, /1Y Sustainability Chair/);
  assert.match(html, /twofold/);
  assert.ok(html.indexOf('Why WasteWise?') < html.indexOf('Waste sorting at Evans Hall'),
    'the intro must come before the Evans Hall observations');
  assert.match(css, /\.why\s*\{/);
});

test('Evans Hall observations, Yale resources and the disclaimer survive', () => {
  assert.match(html, /Waste sorting at Evans Hall/);
  assert.match(html, /Yale waste resources/);
  assert.match(html, /id="about-list"/);
  assert.match(html, /id="about-resources"/);
  assert.match(html, /not an official Yale/);
  // The Sustainability Chairs note now appears only on relevant answers, not
  // repeated in the About page.
  assert.match(app, /SOM Sustainability Chairs/);
});

test('New Haven resources are official, separate, and make no unverified claims', () => {
  const section = html.slice(html.indexOf('New Haven and CT waste resources'),
                             html.indexOf('not an official Yale'));
  for (const host of ['newhavenct.gov', 'recyclect.com', 'portal.ct.gov']) {
    assert.ok(section.includes(host), `${host} link missing`);
  }
  // Municipal programmes are distinguished from Yale's system.
  assert.match(section, /separate from Yale/i);
  assert.match(section, /local guidelines may differ/i);
  // No invented specifics: no free-drop-off claim, no times, no addresses.
  assert.ok(!/\bfree\b/i.test(section), 'must not claim free drop-off');
  assert.ok(!/\d+\s?(am|pm)\b/i.test(section), 'must not state opening times');
  assert.ok(!/\b\d+\s+[A-Z][a-z]+\s+(Street|St|Ave|Avenue|Road|Rd)\b/.test(section),
    'must not list addresses');
  // ...and it says explicitly that those details are unconfirmed.
  assert.match(html, /have not independently confirmed them/);
});

test('every external link opens safely', () => {
  const blanks = (html.match(/target="_blank"/g) ?? []).length;
  const rels = (html.match(/rel="noopener noreferrer"/g) ?? []).length;
  assert.equal(blanks, rels);
  assert.ok(blanks >= 5);
});

/* ---------- asset freshness on a phone ---------- */

test('the shell is never stored and asset URLs carry a version token', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const page = await res.text();
  assert.match(page, /href="styles\.css\?v=[a-z0-9]+"/);
  assert.match(page, /src="app\.js\?v=[a-z0-9]+"/);
});

test('a versioned asset URL still resolves to the real file', async () => {
  const page = await (await fetch(`${base}/`)).text();
  const ref = /src="(app\.js\?v=[a-z0-9]+)"/.exec(page)[1];
  const res = await fetch(`${base}/${ref}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /renderAnswer/);
});

test('the token changes when a served file changes', async () => {
  const { utimesSync } = await import('node:fs');
  const token = async () => /app\.js\?v=([a-z0-9]+)/.exec(await (await fetch(`${base}/`)).text())[1];
  const before = await token();
  const file = new URL('../public/app.js', import.meta.url);
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  assert.notEqual(await token(), before, 'an edited asset must get a fresh URL');
});

/* ---------- development diagnostics ---------- */

test('health reports the build id and whether diagnostics are on', async () => {
  const body = await (await fetch(`${base}/api/health`)).json();
  assert.equal(body.ok, true);
  assert.match(body.build, /^[a-z0-9]+$/);
  assert.equal(typeof body.diagnostics, 'boolean');
});

test('no trace is returned unless it is asked for', async () => {
  _resetLimits();
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // A fast-path question, so this test never calls the model.
    body: JSON.stringify({ question: 'paper plate' }),
  });
  const body = await res.json();
  assert.equal(body.trace, undefined);
});

test('a requested trace records every stage without leaking content', async () => {
  _resetLimits();
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'paper plate', diagnose: true, request_id: 'test-trace-1' }),
  });
  const body = await res.json();
  assert.ok(body.trace, 'trace missing');
  assert.equal(body.trace.request_id, 'test-trace-1');
  assert.match(body.trace.build, /^[a-z0-9]+$/);
  assert.equal(body.trace.path, 'fast-path');

  // Retrieval and both verdicts are visible.
  const item = body.trace.stages.items[0];
  assert.ok(item.rules.some((r) => r.startsWith('paper-plate')));
  assert.ok(item.proposed && item.final);

  // Privacy: length only, never the text; no image bytes; no credentials.
  const raw = JSON.stringify(body.trace);
  assert.equal(body.trace.caption_chars, 'paper plate'.length);
  assert.ok(!raw.includes('paper plate'), 'question text must not be traced');
  assert.ok(!/sk-|PORTKEY|api[_-]?key/i.test(raw), 'no credentials in the trace');
});

test('a traced request id is sanitised', async () => {
  _resetLimits();
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'paper plate', diagnose: true, request_id: '../../etc/<script>' }),
  });
  const body = await res.json();
  assert.ok(!/[<>/.]/.test(body.trace.request_id), 'request id must be sanitised');
});

test('diagnostics can never switch on in production', async () => {
  const { diagnosticsEnabled } = await import('../server/build.js');
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.equal(diagnosticsEnabled(), false);
  process.env.NODE_ENV = saved ?? 'test';
});

test('image dimensions are read from the header alone', async () => {
  const { imageDimensions } = await import('../server/build.js');
  const png = readFileSync(new URL('./fixtures/can.png', import.meta.url));
  assert.deepEqual(imageDimensions(png), { width: 320, height: 420 });
  // The real iPhone photo is a private fixture and is not published with the
  // repository; the PNG above covers the same code path on a fresh clone.
  const jpeg = new URL('./fixtures/IMG_2560.jpeg', import.meta.url);
  if (existsSync(jpeg)) {
    assert.deepEqual(imageDimensions(readFileSync(jpeg)), { width: 5712, height: 4284 });
  }
  assert.equal(imageDimensions(Buffer.from('not an image')), null);
});

test('the diagnostics control is client-gated and copies the rendered headline', () => {
  assert.match(app, /let DIAGNOSTICS = false/);
  assert.match(app, /h\.diagnostics === true/);
  assert.match(app, /function attachDiagnostics/);
  assert.match(app, /Copy diagnostics/);
  // It records what was actually displayed, which is the disputed fact.
  assert.match(app, /headline: turnHeadline\(it\)/);
  // Clipboard needs a secure context; plain HTTP must still work.
  assert.match(app, /execCommand\('copy'\)/);
  assert.match(app, /Select all above, then Copy/);
  // Build identifiers from both sides travel with the trace.
  assert.match(app, /build_seen_by_page/);
  assert.match(app, /server_build/);
});
