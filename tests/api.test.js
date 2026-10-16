import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the DB at a scratch file before any module imports db.js.
const dir = mkdtempSync(join(tmpdir(), 'wastewise-test-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';

const { default: app } = await import('../server/index.js');
const { _resetLimits } = await import('../server/middleware/limits.js');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  _resetLimits();
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/health', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // Health now also reports which build is running and whether the
  // development trace is available.
  assert.match(body.build, /^[a-z0-9]+$/);
  assert.equal(typeof body.diagnostics, 'boolean');
});

test('GET /api/guide returns student-facing items, about notes and resources', async () => {
  const body = await (await fetch(`${base}/api/guide`)).json();
  assert.ok(body.items.length >= 10);
  assert.ok(body.about.length >= 1);
  assert.ok(body.resources.length >= 1);
  for (const item of body.items) {
    assert.ok(item.icon && item.destination && item.tip && item.detail, `${item.id} incomplete`);
  }
  // The model-facing `guidance` field must never be exposed to the browser.
  // (The word itself may legitimately appear inside a citation.)
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('"guidance"'), 'guide must not ship the model-facing guidance field');
  assert.ok(!('guidance' in body.items[0]), 'guide items must not carry model instructions');
  assert.doesNotMatch(raw, /DO NOT ask|ALWAYS MENTION|IMPORTANT EXCEPTION/);
});

test('GET / serves the WasteWise page', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /WasteWise/);
});

test('POST /api/ask rejects an empty question without calling the API', async () => {
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/feedback rejects an unknown query_id', async () => {
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_id: 99999, helpful: true }),
  });
  assert.equal(res.status, 400);
});

test('GET /api/usage returns aggregate counters', async () => {
  const body = await (await fetch(`${base}/api/usage`)).json();
  assert.equal(typeof body.totals.queries, 'number');
  assert.equal(typeof body.totals.input_tokens, 'number');
  assert.equal(typeof body.clarifications.asked, 'number');
  // null when no per-token rate is configured — deliberately not 0, which would
  // read as "this cost nothing".
  assert.ok(
    body.totals.estimated_cost_usd === null || typeof body.totals.estimated_cost_usd === 'number',
    'estimated_cost_usd must be a number or null',
  );
});

test('rate limiting kicks in before the daily cap', async () => {
  _resetLimits();
  const ask = () =>
    fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '' }), // 400s before any API call
    });
  // Empty questions are rejected after the limiter runs, so the limiter still counts them.
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await ask()).status);
  assert.ok(codes.includes(429), `expected a 429 among ${codes}`);
});
