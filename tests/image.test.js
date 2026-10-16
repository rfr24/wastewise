import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateImage, MAX_IMAGE_BYTES } from '../server/middleware/image.js';
import { identificationToQuery } from '../server/services/vision.js';
import { retrieveRules } from '../server/services/rules.js';

const pngPath = new URL('./fixtures/red-circle.png', import.meta.url);
const pngBase64 = readFileSync(pngPath).toString('base64');

/* ---------- upload validation ---------- */

test('a real PNG passes validation as a data URL or as an object', () => {
  assert.equal(validateImage(`data:image/png;base64,${pngBase64}`).ok, true);
  assert.equal(validateImage({ media_type: 'image/png', data: pngBase64 }).ok, true);
});

test('a file whose bytes do not match its declared type is rejected', () => {
  // A shell script relabeled as a JPEG — the magic-byte check catches it.
  const evil = Buffer.from('#!/bin/sh\nrm -rf /\n').toString('base64');
  const r = validateImage({ media_type: 'image/jpeg', data: evil });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not look like a real/i);
});

test('a PNG mislabeled as JPEG is rejected', () => {
  const r = validateImage({ media_type: 'image/jpeg', data: pngBase64 });
  assert.equal(r.ok, false);
});

test('disallowed formats are rejected', () => {
  for (const type of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/html']) {
    const r = validateImage({ media_type: type, data: pngBase64 });
    assert.equal(r.ok, false, `${type} must be rejected`);
    assert.match(r.error, /JPEG, PNG, or WebP/);
  }
});

test('oversized images are rejected before decoding', () => {
  const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) * 4 / 3));
  const r = validateImage({ media_type: 'image/png', data: huge });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/i);
});

test('malformed and empty input is rejected', () => {
  for (const bad of [null, undefined, '', 'not-a-data-url', { media_type: 'image/png' },
                     { media_type: 'image/png', data: '!!!not base64!!!' },
                     { media_type: 'image/png', data: '' }]) {
    assert.equal(validateImage(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

/* ---------- identification feeds the existing rules pipeline ---------- */

test('a photo identification is turned into a rules query', () => {
  const q = identificationToQuery(
    { item: 'paper hot cup', material: 'paper with plastic lining', condition: 'clean', resin_code: null },
    '',
  );
  assert.match(q, /paper hot cup/);
  // ...and that query must reach the right Yale rule through normal retrieval.
  assert.equal(retrieveRules(q)[0].id, 'coffee-cup-paper');
});

test('item condition does not leak into rule retrieval', () => {
  // "clean" describes state, not kind — it must not pull in the clean-paper rule.
  const q = identificationToQuery(
    { item: 'gray pullover', material: 'knit fabric', condition: 'clean', resin_code: null }, '',
  );
  assert.doesNotMatch(q, /clean/);
  assert.equal(retrieveRules(q).length, 0, 'a garment matches no waste rule');
});

test('a visible resin code routes a plastic cup to the plastics rule', () => {
  const q = identificationToQuery(
    { item: 'clear plastic cup', material: 'clear plastic', condition: 'clean', resin_code: '1' },
    '',
  );
  assert.equal(retrieveRules(q)[0].id, 'plastic-cold-cup');
});

test('an unidentifiable photo yields no rules rather than a guess', () => {
  const q = identificationToQuery(
    { item: null, material: null, condition: 'unknown', resin_code: null }, '',
  );
  assert.equal(retrieveRules(q).length, 0);
});

test('a typed caption is combined with the photo identification', () => {
  const q = identificationToQuery(
    { item: 'fork', material: 'plastic', condition: 'clean', resin_code: null },
    "at Charley's Place",
  );
  assert.match(q, /Charley/);
});

/* ---------- the vision pass must not decide a stream ---------- */

test('the vision prompt forbids disposal advice and never sees the rules', async () => {
  const src = readFileSync(new URL('../server/services/vision.js', import.meta.url), 'utf8');
  assert.match(src, /must NOT decide where anything goes/i);
  // The rules knowledge base must not be reachable from the vision pass.
  assert.doesNotMatch(src, /formatRulesForPrompt|retrieveRules|loadRules/);
});
