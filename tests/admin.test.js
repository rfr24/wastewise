import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ww-admin-'));
process.env.DB_PATH = join(dir, 'admin.db');
process.env.ADMIN_PASSWORD = 'correct-horse-battery';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret-at-least-16-chars';
// Thresholds are read once at import; lower them so the fixtures can exercise
// the pattern logic rather than the limited-data guard.
process.env.OPPORTUNITY_MIN_SAMPLE = '4';
process.env.PORTKEY_API_KEY ??= 'test-key';

const { default: appServer } = await import('../server/index.js');
const { recordQuery, recordFeedback } = await import('../server/services/db.js');
const { _resetLoginThrottle } = await import('../server/admin-auth.js');

let server;
let base;
let cookie = '';

const login = async (password = 'correct-horse-battery') => {
  _resetLoginThrottle();
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
};
/*
 * Operational views exclude development traffic by default, and rows inserted
 * by these tests are development. Unless a test is specifically about cohort
 * filtering it asks for every cohort, so it exercises the metric rather than
 * the filter.
 */
const authed = (path) => {
  const url = path.includes('cohort=')
    ? path
    : `${path}${path.includes('?') ? '&' : '?'}cohort=all`;
  return fetch(`${base}${url}`, { headers: { cookie } });
};

const ADMIN_ENDPOINTS = ['/api/admin/overview', '/api/admin/insights',
  '/api/admin/feedback', '/api/admin/opportunities'];

before(async () => {
  server = appServer.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

/* ---------- access control ---------- */

test('every admin endpoint refuses an unauthenticated caller', async () => {
  for (const ep of ADMIN_ENDPOINTS) {
    const res = await fetch(`${base}${ep}`);
    assert.equal(res.status, 401, `${ep} should require a session`);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes('correct-horse'), 'never echo the secret');
  }
});

test('the dashboard page is not served to an unauthenticated visitor', async () => {
  const html = await (await fetch(`${base}/admin`)).text();
  assert.match(html, /login-form/);
  assert.ok(!html.includes('kpi-grid'), 'dashboard markup must not be served signed out');
  assert.ok(!html.includes('opportunities-body'));
});

test('a forged or tampered session cookie is rejected', async () => {
  await login();
  const tampered = `${cookie.split('.')[0]}.not-a-valid-signature`;
  const res = await fetch(`${base}/api/admin/overview`, { headers: { cookie: tampered } });
  assert.equal(res.status, 401);
});

test('a wrong password is refused and reveals nothing', async () => {
  const res = await login('wrong-password');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Incorrect password.');
  assert.ok(!res.headers.get('set-cookie'), 'no session on failure');
});

test('a correct password issues a hardened session cookie', async () => {
  _resetLoginThrottle();
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-horse-battery' }),
  });
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  assert.ok(!sc.includes('correct-horse-battery'), 'the secret must never be in the cookie');
});

test('repeated failures are throttled', async () => {
  _resetLoginThrottle();
  let sawThrottle = false;
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    if (res.status === 429) { sawThrottle = true; break; }
  }
  assert.ok(sawThrottle, 'brute force should be rate limited');
});

test('logout clears the session', async () => {
  await login();
  assert.equal((await authed('/api/admin/overview')).status, 200);
  const out = await fetch(`${base}/api/admin/logout`, { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('the admin secret never reaches the browser', async () => {
  await login();
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const js = await (await fetch(`${base}/admin/dashboard.js`)).text();
  const loginJs = await (await fetch(`${base}/admin/login.js`)).text();
  for (const asset of [page, js, loginJs]) {
    assert.ok(!asset.includes('correct-horse-battery'));
    assert.ok(!/ADMIN_PASSWORD/.test(asset));
  }
});

/* ---------- metrics on real rows ---------- */

test('an empty database reports zeros, not fabricated figures', async () => {
  await login();
  const o = await (await authed('/api/admin/overview?range=all')).json();
  assert.equal(o.queries, 0);
  assert.equal(o.photo_share, null, 'no share without a denominator');
  assert.equal(o.feedback.helpful_share, null);
  assert.equal(o.latency.median_ms, null);
  const i = await (await authed('/api/admin/insights?range=all')).json();
  assert.equal(i.item_level.items, 0);
  assert.deepEqual(i.item_level.top_items, []);
  assert.equal(i.query_level.queries, 0);
  assert.equal(i.query_level.photo.unresolved_share, null);
  const opp = await (await authed('/api/admin/opportunities?range=all')).json();
  assert.deepEqual(opp.opportunities, []);
});

test('aggregates are computed from the rows actually stored', async () => {
  const a = recordQuery({
    question: 'paper plate', had_image: 0, identified_item: 'Paper plate', category: 'foodservice',
    recommendation: 'trash', confidence: 'confirmed', input_tokens: 10, output_tokens: 5,
    estimated_cost_usd: 0, latency_ms: 120,
  });
  recordQuery({
    question: 'photo', had_image: 1, identified_item: 'Wrapper', category: 'plastics',
    recommendation: 'multiple', confidence: 'multiple', needs_clarification: 1,
    input_tokens: 100, output_tokens: 50, latency_ms: 900,
    items: [
      { identified_item: 'wrapper', category: 'plastics', recommendation: 'trash', confidence: 'likely' },
      { identified_item: 'scone', category: 'food_waste', recommendation: 'unknown',
        confidence: 'uncertain', needs_clarification: true, observed_action: true },
    ],
  });
  recordFeedback({ query_id: a, helpful: true, comment: 'Clear and quick' });

  await login();
  const o = await (await authed('/api/admin/overview?range=all')).json();
  assert.equal(o.queries, 2);
  assert.equal(o.photo_queries, 1);
  assert.equal(o.text_queries, 1);
  assert.equal(o.tokens.input, 110);
  assert.equal(o.feedback.total, 1);
  assert.equal(o.feedback.helpful_share, 1);
  assert.equal(o.latency.samples, 2);
  assert.equal(o.latency.median_ms, 120);

  // Multi-item photos are itemised, so "multiple" never hides the destinations.
  const i = await (await authed('/api/admin/insights?range=all')).json();
  const dest = Object.fromEntries(i.item_level.destinations.map((d) => [d.name, d.count]));
  assert.equal(dest.trash, 2, 'the typed answer plus the wrapper');
  assert.equal(dest.unknown, 1, 'the scone');
  assert.ok(!dest.multiple, 'the parent row must not be double counted');
});

test('cost is reported with its coverage rather than summing to a false zero', async () => {
  await login();
  const o = await (await authed('/api/admin/overview?range=all')).json();
  // One row priced at 0, one row with no rate at all.
  assert.equal(o.cost.priced_queries, 1);
  assert.equal(o.queries, 2);
  assert.ok(o.cost.coverage < 1, 'partial coverage must be visible to the UI');
  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /Cost known for/);
});

/* ---------- date filters ---------- */

test('the date filter narrows the window and fills empty days', async () => {
  await login();
  const all = await (await authed('/api/admin/overview?range=all')).json();
  const week = await (await authed('/api/admin/overview?range=7d')).json();
  assert.equal(all.range_start, null, 'all time has no lower bound');
  assert.ok(week.range_start, '7d must have a lower bound');
  assert.equal(week.daily.length, 7, 'every day appears, including quiet ones');
  assert.ok(week.queries <= all.queries);
});

test('an unknown range falls back to all time rather than erroring', async () => {
  await login();
  const res = await authed('/api/admin/overview?range=../etc/passwd');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).range, 'all');
});

/* ---------- feedback safety ---------- */

test('comments are returned to admins but never interpolated into markup', async () => {
  const q = recordQuery({ question: 'x', recommendation: 'trash', identified_item: 'Cup' });
  recordFeedback({ query_id: q, helpful: false, comment: '<img src=x onerror=alert(1)>' });

  await login();
  const f = await (await authed('/api/admin/feedback?range=all')).json();
  const hostile = f.comments.find((c) => c.comment.includes('onerror'));
  assert.ok(hostile, 'the comment is available to the admin verbatim');

  // The renderer must use textContent for anything a student wrote.
  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /el\('p', 'comment-body', c\.comment\)/);
  assert.ok(!/innerHTML\s*=\s*`/.test(js), 'no template interpolation of data into markup');
  assert.match(js, /if \(text !== undefined && text !== null\) node\.textContent/);
});

test('student question text is not exposed by the aggregate endpoints', async () => {
  await login();
  for (const ep of ['/api/admin/overview', '/api/admin/insights', '/api/admin/opportunities']) {
    const raw = JSON.stringify(await (await authed(`${ep}?range=all`)).json());
    assert.ok(!raw.includes('paper plate'), `${ep} must not leak raw question text`);
  }
});

/* ---------- opportunities ---------- */

test('opportunities need a threshold of observations and explain themselves', async () => {
  for (let i = 0; i < 4; i++) {
    recordQuery({
      question: 'q', had_image: 0, identified_item: 'Mystery foam thing', category: 'other',
      recommendation: 'unknown', confidence: 'uncertain',
    });
  }
  await login();
  const o = await (await authed('/api/admin/opportunities?range=all')).json();
  const found = o.opportunities.find((x) => x.title.includes('Mystery foam thing'));
  assert.ok(found, 'a repeated unresolved item should surface');
  for (const field of ['observed', 'why', 'next_step']) {
    assert.ok(found[field]?.length > 10, `${field} must be explained`);
  }
  // Framed as something to look into, not a proven deficiency.
  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /not evidence that sorting behaviour changed/);
});

/* ---------- the student experience is untouched ---------- */

test('the public assistant still works and never links to the dashboard', async () => {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/guide`)).status, 200);
  const page = await (await fetch(`${base}/`)).text();
  assert.ok(!page.includes('/admin'), 'the dashboard must not appear in student navigation');
  // The student page is unchanged: no login, no admin controls.
  assert.ok(!/password/i.test(page));
});

test('the dashboard states what the data cannot show', async () => {
  await login();
  const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  // The footer now carries the short form; the full methodology lives in the
  // expandable definitions rendered by dashboard.js.
  const text = html.replace(/\s+/g, ' ');
  assert.match(text, /not students, and not disposal\s*actions/);
  assert.match(text, /How these numbers work/);

  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /no accounts or sessions/);
  assert.match(js, /contamination, diversion, or any change in behaviour/);
});

/* ---------- query-level and item-level denominators ---------- */

test('photo versus typed counts use every query, not the itemised subset', async () => {
  // A multi-item photo recorded WITHOUT per-item rows, exactly as the historical
  // rows were: this is what silently vanished from the channel comparison.
  recordQuery({
    question: 'legacy photo', had_image: 1, recommendation: 'multiple',
    confidence: 'multiple', needs_clarification: 1,
  });

  await login();
  const i = await (await authed('/api/admin/insights?range=all')).json();
  const o = await (await authed('/api/admin/overview?range=all')).json();

  // The two sections must agree on how many questions there were.
  assert.equal(i.query_level.queries, o.queries);
  assert.equal(i.query_level.photo.queries, o.photo_queries);
  assert.equal(i.query_level.text.queries, o.text_queries);
});

test('an unresolved share is reported with the coverage it rests on', async () => {
  await login();
  const i = await (await authed('/api/admin/insights?range=all')).json();
  const photo = i.query_level.photo;

  // A "multiple" row has no single outcome, so it counts towards the channel
  // but not towards the unresolved denominator.
  assert.ok(photo.outcome_known <= photo.queries);
  assert.ok(photo.outcome_coverage <= 1);
  if (photo.outcome_known < photo.queries) {
    assert.ok(photo.outcome_coverage < 1, 'partial coverage must be visible');
  }
  // The UI has to show that caveat rather than printing a bare percentage.
  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /function coverageNote/);
  assert.match(js, /Based on \$\{num\(known\)\} of \$\{num\(total\)\}/);
});

test('item-level blocks declare how many questions they speak for', async () => {
  await login();
  const i = await (await authed('/api/admin/insights?range=all')).json();
  const it = i.item_level;
  assert.equal(typeof it.items, 'number');
  assert.equal(it.contributing_queries + it.excluded_queries, it.total_queries);
  assert.ok(it.excluded_queries >= 1, 'the legacy multi-item row should be excluded');
  assert.ok(it.coverage < 1);
});

test('query-level and item-level results are kept in separate blocks', async () => {
  await login();
  const i = await (await authed('/api/admin/insights?range=all')).json();
  assert.ok(i.query_level && i.item_level, 'scopes must be explicit in the payload');
  // The old flat shape conflated them under one set of denominators.
  assert.equal(i.channels, undefined);
  assert.equal(i.destinations, undefined);
  assert.equal(i.item_count, undefined);
  // And the interface labels which scope a reader is looking at.
  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /scopeTag\('Query level'\)/);
  assert.match(js, /scopeTag\('Item level'\)/);
});

test('a channel with no determinate outcome reports null, never zero percent', async () => {
  const { insights } = await import('../server/services/analytics.js');
  const i = insights('all');
  for (const c of [i.query_level.photo, i.query_level.text]) {
    if (c.outcome_known === 0) {
      assert.equal(c.unresolved_share, null, 'no denominator means no percentage');
      assert.equal(c.unresolved, null);
    }
  }
});

test('opportunities declare the same coverage limit', async () => {
  await login();
  const o = await (await authed('/api/admin/opportunities?range=all')).json();
  assert.equal(typeof o.excluded_queries, 'number');
  assert.equal(o.contributing_queries + o.excluded_queries, o.total_queries);
});
