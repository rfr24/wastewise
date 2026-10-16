import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ww-cohort-'));
process.env.DB_PATH = join(dir, 'cohorts.db');
process.env.ADMIN_PASSWORD = 'cohort-test-password';
process.env.ADMIN_SESSION_SECRET = 'cohort-session-secret-16-plus-chars';
process.env.EVAL_ACCESS_CODE = 'eval-code-123';
process.env.OPPORTUNITY_MIN_SAMPLE = '4';
process.env.PORTKEY_API_KEY ??= 'test-key';

const { default: appServer } = await import('../server/index.js');
const { recordQuery, recordFeedback } = await import('../server/services/db.js');
const analytics = await import('../server/services/analytics.js');
const cohortMod = await import('../server/cohort.js');

let server;
let base;
let cookie = '';

const seed = (cohort, n, extra = {}) => {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(recordQuery({
      question: `q-${cohort}-${i}`, had_image: 0, identified_item: 'Paper plate',
      category: 'foodservice', recommendation: 'trash', confidence: 'confirmed',
      matched_rule_ids: ['paper-plate'], cohort, ...extra,
    }));
  }
  return ids;
};

const login = async () => {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'cohort-test-password' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
};
const get = (path) => fetch(`${base}${path}`, { headers: { cookie } }).then((r) => r.json());

test('start server', async () => {
  server = appServer.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  seed('development', 6);
  seed('student_eval', 3);
  // Public is deliberately left empty at first, so the empty-cohort behaviour
  // can be asserted against a cohort that genuinely has no rows.
  recordFeedback({ query_id: seed('development', 1)[0], helpful: false, comment: 'dev note' });
  await login();
});

/* ---------- cohort separation ---------- */

test('operational views exclude development traffic by default', async () => {
  const dflt = await get('/api/admin/overview?range=all');
  assert.equal(dflt.cohort, 'operational');
  assert.equal(dflt.queries, 3, 'student evaluation only, development excluded');

  const all = await get('/api/admin/overview?range=all&cohort=all');
  assert.equal(all.queries, 10);
  const dev = await get('/api/admin/overview?range=all&cohort=development');
  assert.equal(dev.queries, 7);
});

test('an empty cohort reports nothing rather than failing', async () => {
  // Nothing has been recorded as public at all yet.
  const o = await get('/api/admin/overview?range=all&cohort=public');
  assert.equal(o.queries, 0);
  assert.equal(typeof o.queries, 'number');
  assert.equal(o.photo_share, null);
  assert.equal(o.feedback.helpful_share, null);
  const i = await get('/api/admin/insights?range=all&cohort=public');
  assert.equal(i.query_level.photo.unresolved_share, null);
  assert.deepEqual(i.item_level.top_items, []);
});

test('each cohort can be viewed on its own', async () => {
  assert.equal((await get('/api/admin/overview?range=all&cohort=student_eval')).queries, 3);
  seed('public', 2);
  assert.equal((await get('/api/admin/overview?range=all&cohort=public')).queries, 2);
});

test('feedback inherits the cohort of the query it belongs to', async () => {
  // The only feedback was left on a development query.
  assert.equal((await get('/api/admin/overview?range=all&cohort=development')).feedback.total, 1);
  assert.equal((await get('/api/admin/overview?range=all&cohort=operational')).feedback.total, 0);
  const fb = await get('/api/admin/feedback?range=all&cohort=operational');
  assert.deepEqual(fb.comments, [], 'development comments must not leak into operational views');
});

test('an unknown cohort falls back to the operational default', async () => {
  const o = await get('/api/admin/overview?range=all&cohort=;DROP TABLE queries');
  assert.equal(o.cohort, 'operational');
  assert.equal((await get('/api/admin/overview?range=all')).queries, o.queries);
});

/* ---------- cohort cannot be claimed by the caller ---------- */

test('a public caller cannot label its own traffic', async () => {
  for (const body of [
    { question: 'paper plate', cohort: 'public' },
    { question: 'paper plate', cohort: 'student_eval' },
  ]) {
    const res = await fetch(`${base}/api/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
  }
  // Both land in the default cohort for this environment, not the claimed one.
  const after = await get('/api/admin/overview?range=all&cohort=development');
  assert.ok(after.queries >= 9, 'claimed cohorts were ignored');
  assert.equal((await get('/api/admin/overview?range=all&cohort=public')).queries, 2);
});

test('only a valid evaluation code marks a session', async () => {
  const good = await fetch(`${base}/eval?code=eval-code-123`, { redirect: 'manual' });
  assert.match(good.headers.get('set-cookie') ?? '', /ww_cohort=student_eval/);
  assert.match(good.headers.get('set-cookie') ?? '', /HttpOnly/);

  const bad = await fetch(`${base}/eval?code=not-the-code`, { redirect: 'manual' });
  assert.ok(!(bad.headers.get('set-cookie') ?? '').includes('ww_cohort=student_eval'));
  // Both redirect to the assistant, so a wrong code reveals nothing.
  assert.equal(good.status, 302);
  assert.equal(bad.status, 302);
});

test('a forged cohort cookie is rejected', async () => {
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'ww_cohort=student_eval.forged' },
    body: JSON.stringify({ question: 'aluminum can' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await get('/api/admin/overview?range=all&cohort=student_eval')).queries, 3,
    'an unsigned cookie must not add to the evaluation cohort');
});

test('the cohort endpoint reports configuration without secrets', async () => {
  const c = await get('/api/admin/cohorts');
  assert.ok(c.labels.development && c.labels.student_eval && c.labels.public);
  assert.equal(c.default_filter, 'operational');
  assert.equal(c.evaluation_enabled, true);
  const raw = JSON.stringify(c);
  assert.ok(!raw.includes('eval-code-123'), 'the evaluation code must not be exposed');
  assert.ok(!raw.includes('cohort-test-password'));
});

/* ---------- conservative item grouping ---------- */

test('items are grouped by the rule they matched, not by wording', () => {
  const rows = [
    { item: 'clear plastic snack wrapper', rule_ids: '["plastic-film-bags"]', recommendation: 'trash' },
    { item: 'clear plastic wrapper', rule_ids: '["plastic-film-bags"]', recommendation: 'trash' },
    { item: 'plastic packaging', rule_ids: '["plastic-film-bags"]', recommendation: 'trash' },
    // No rule matched: this must stay on its own rather than being merged by
    // the word "plastic".
    { item: 'plastic packaging', rule_ids: '[]', recommendation: 'unknown' },
    { item: 'rigid plastic takeout container', rule_ids: '[]', recommendation: 'unknown' },
  ];
  const groups = analytics.groupItems(rows);
  const merged = groups.find((g) => g.rule_id === 'plastic-film-bags');
  assert.equal(merged.count, 3, 'three descriptions sharing a rule merge');
  assert.equal(merged.grouped_by, 'matched rule');
  assert.match(merged.name, /Plastic bag, film or flexible packaging/);

  // Unmatched descriptions are not merged into the film group.
  const unmatched = groups.filter((g) => !g.rule_id);
  assert.equal(unmatched.length, 2);
  assert.ok(unmatched.every((g) => g.grouped_by === 'exact description'));
});

test('grouping preserves the original descriptions for inspection', () => {
  const groups = analytics.groupItems([
    { item: 'clear plastic snack wrapper', rule_ids: '["plastic-film-bags"]' },
    { item: 'clear plastic wrapper', rule_ids: '["plastic-film-bags"]' },
    { item: 'clear plastic wrapper', rule_ids: '["plastic-film-bags"]' },
  ]);
  const g = groups[0];
  const descriptions = g.variants.map((v) => v.description);
  assert.ok(descriptions.includes('clear plastic wrapper'));
  assert.ok(descriptions.includes('clear plastic snack wrapper'));
  assert.equal(g.variants.find((v) => v.description === 'clear plastic wrapper').count, 2);
  // The internal grouping handle is not shipped to the browser.
  assert.equal(g.key, undefined);
});

test('a group never mixes two different rules', () => {
  const groups = analytics.groupItems([
    { item: 'wrapper', rule_ids: '["plastic-film-bags"]' },
    { item: 'wrapper', rule_ids: '["paper-plate"]' },
  ]);
  assert.equal(groups.length, 2, 'same wording, different rules, stays separate');
});

/* ---------- opportunities ---------- */

test('too little data yields a limited-data message, not weak findings', async () => {
  const o = await get('/api/admin/opportunities?range=all&cohort=public');
  assert.equal(o.limited_data, true);
  assert.deepEqual(o.opportunities, []);
  assert.ok(o.min_sample > 0);
});

test('development-only views say so rather than implying student behaviour', async () => {
  const o = await get('/api/admin/opportunities?range=all&cohort=development');
  assert.equal(o.development_only, true);
  const js = readFileSync(new URL('../public/admin/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /not as observations of student behaviour/);
  assert.match(js, /COHORT_TEXT/);
});

test('overlapping food-waste concerns are consolidated into one card', async () => {
  seed('public', 5, {
    identified_item: 'Leftover food', recommendation: 'unknown', confidence: 'uncertain',
    matched_rule_ids: ['food-scraps'],
  });
  seed('public', 3, {
    identified_item: 'Compost in Evans Hall', recommendation: 'unknown', confidence: 'uncertain',
    matched_rule_ids: ['evans-compost-availability'],
  });
  const o = await get('/api/admin/opportunities?range=all&cohort=public');
  const food = o.opportunities.filter((x) => /food|compost/i.test(x.title));
  assert.equal(food.length, 1, 'one card, not one per rule');
  assert.match(food[0].title, /Evans Hall/);
  assert.equal(food[0].type, 'campus-question');
  assert.match(food[0].next_step, /SOM Facilities/);
});

test('a knowledge-base gap is distinguished from a campus problem', async () => {
  seed('public', 4, {
    identified_item: 'Mystery foam object', recommendation: 'unknown',
    confidence: 'uncertain', matched_rule_ids: [],
  });
  const o = await get('/api/admin/opportunities?range=all&cohort=public');
  const gap = o.opportunities.find((x) => /Mystery foam object/.test(x.title));
  assert.ok(gap, 'an unmatched repeated item should surface');
  assert.equal(gap.type, 'knowledge-gap');
  assert.match(gap.why, /knowledge base rather than evidence of a problem with campus waste/);
  // Never claims anything about disposal behaviour or contamination.
  for (const o2 of o.opportunities) {
    assert.ok(!/contaminat|disposed incorrectly|behaviour change/i.test(o2.why + o2.observed));
  }
});

/* ---------- fresh database ---------- */

test('a fresh database initialises with every migration applied', async () => {
  const freshDir = mkdtempSync(join(tmpdir(), 'ww-fresh-'));
  const freshPath = join(freshDir, 'fresh.db');
  const saved = process.env.DB_PATH;
  process.env.DB_PATH = freshPath;
  // A separate module instance, so this opens the new file rather than reusing
  // the connection the suite already holds.
  const fresh = await import(`../server/services/db.js?fresh=${Date.now()}`);
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(freshPath);

  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((t) => t.name);
  for (const t of ['queries', 'feedback', 'query_items']) {
    assert.ok(tables.includes(t), `${t} must exist on a fresh database`);
  }
  const cols = raw.prepare("PRAGMA table_info('queries')").all().map((c) => c.name);
  for (const c of ['cohort', 'latency_ms']) {
    assert.ok(cols.includes(c), `${c} must be present without a manual migration`);
  }
  // It starts genuinely empty — no development records are carried over.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM queries').get().n, 0);
  const id = fresh.recordQuery({ question: 'x', recommendation: 'trash', cohort: 'public' });
  assert.ok(id > 0, 'a fresh database accepts writes immediately');

  process.env.DB_PATH = saved;
  rmSync(freshDir, { recursive: true, force: true });
});

/* ---------- security ---------- */

test('production admin sign-in requires HTTPS', async () => {
  const { requiresSecureTransport } = await import('../server/admin-auth.js');
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.equal(requiresSecureTransport({ secure: false, headers: {} }), true);
  assert.equal(requiresSecureTransport({ secure: true, headers: {} }), false);
  assert.equal(
    requiresSecureTransport({ secure: false, headers: { 'x-forwarded-proto': 'https' } }), false);
  process.env.NODE_ENV = saved ?? 'test';
  // Local HTTP development stays usable.
  assert.equal(requiresSecureTransport({ secure: false, headers: {} }), false);
});

test('no database file or secret is committable', () => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const pattern of ['.env', '*.db', '*.sqlite', 'backups/']) {
    assert.ok(ignore.includes(pattern), `${pattern} must be gitignored`);
  }
  assert.ok(ignore.includes('!.env.example'), '.env.example stays available as a template');
});

test('stop server', () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
