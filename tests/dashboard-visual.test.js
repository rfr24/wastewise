import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const adminCss = read('admin/admin.css');
const studentCss = read('styles.css');
const dash = read('admin/dashboard.js');
const dashHtml = read('admin/dashboard.html');
const analytics = readFileSync(
  new URL('../server/services/analytics.js', import.meta.url), 'utf8');

const tokenValue = (css, name) =>
  new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, 'i').exec(css)?.[1]?.toLowerCase() ?? null;

/* ---------- P1: one palette, shared with the student app ---------- */

test('destination colours are copied verbatim from the student stylesheet', () => {
  for (const token of ['--c-recycling', '--c-trash', '--c-food', '--c-dish',
                       '--c-special', '--c-open']) {
    const student = tokenValue(studentCss, token);
    const admin = tokenValue(adminCss, token);
    assert.ok(student, `${token} missing from the student app`);
    assert.equal(admin, student, `${token} must match the student app exactly`);
  }
});

test('each destination bar uses its own colour, not a single green', () => {
  for (const [dest, token] of [
    ['recycling', '--c-recycling'], ['trash', '--c-trash'], ['food_waste', '--c-food'],
    ['return_dishware', '--c-dish'], ['special', '--c-special'], ['unknown', '--c-open'],
  ]) {
    // The selector may be grouped (unknown and multiple share a colour).
    assert.match(adminCss, new RegExp(`\\.bar-fill\\.d-${dest}[^{]*\\{[^}]*var\\(${token}\\)`),
      `${dest} bars must use ${token}`);
    assert.match(dash, new RegExp(`${dest}:\\s*'${token}'`), `${dest} needs a colour mapping`);
  }
});

test('colour is never the only cue', () => {
  // Every bar keeps a written label and an exact count beside it.
  assert.match(dash, /row\.append\(el\('span', 'bar-label'/);
  assert.match(dash, /el\('span', 'bar-value', formatter/);
  // The stacked bar is backed by a legend of counts and an aria description.
  assert.match(dash, /legend-count/);
  assert.match(dash, /stack\.setAttribute\('role', 'img'\)/);
  assert.match(dash, /stack\.setAttribute\(\s*'aria-label'/);
});

test('confidence uses its own scale, not destination colours', () => {
  assert.match(adminCss, /\.bar-fill\.c-confirmed\s*\{[^}]*var\(--c-food\)/);
  assert.match(adminCss, /\.bar-fill\.c-uncertain\s*\{[^}]*var\(--c-open\)/);
  assert.match(dash, /tone: \(r\) => `c-\$\{r\.name\}`/);
  assert.match(dash, /different scale from destination/);
});

/* ---------- P2: Overview hierarchy ---------- */

test('the two decision-relevant metrics lead the Overview', () => {
  assert.match(dash, /card\('Questions asked'[\s\S]{0,160}'kpi-primary'\)/);
  assert.match(dash, /card\('Unresolved'[\s\S]{0,260}'kpi-primary kpi-attention'\)/);
  assert.match(adminCss, /\.kpi\.kpi-primary\s*\{[^}]*grid-column: span 2/);
  assert.match(adminCss, /\.kpi\.kpi-attention \.kpi-value\s*\{[^}]*var\(--c-open\)/);
  // The responsive grid is preserved.
  assert.match(adminCss, /@media \(max-width: 980px\)[\s\S]{0,120}kpi-primary\s*\{\s*grid-column: span 1/);
});

/* ---------- P3: the misleading photo statistic ---------- */

test('photo outcomes are stated as counts, with coverage underneath', () => {
  const block = dash.slice(dash.indexOf("const grid = el('div', 'split')"),
                           dash.indexOf('host.append(chan)'));
  // Counts of eligible questions, not a bare percentage.
  assert.match(block, /eligible \$\{noun\} questions unresolved/);
  assert.match(block, /Outcome data available for \$\{num\(c\.outcome_known\)\} of \$\{num\(c\.queries\)\}/);
  assert.match(block, /coverage\)/);
  // Every number is interpolated from the response.
  assert.ok(!/\b7 of 57\b|\b100%\b/.test(block), 'no hardcoded figures');
  assert.match(block, /c\.outcome_coverage/);
});

test('a channel with no outcome data says so instead of showing a share', () => {
  const block = dash.slice(dash.indexOf("const grid = el('div', 'split')"),
                           dash.indexOf('host.append(chan)'));
  assert.match(block, /c\.outcome_known === 0/);
  assert.match(block, /No outcome data recorded/);
});

test('destinations render as a stacked distribution with counts', () => {
  assert.match(dash, /function stackedDistribution/);
  assert.match(dash, /dest\.append\(stackedDistribution\(it\.destinations/);
  assert.match(adminCss, /\.stack\s*\{/);
  assert.match(adminCss, /\.legend-row\s*\{/);
});

test('item-level coverage stays visible on the destinations card', () => {
  const block = dash.slice(dash.indexOf("const dest = section("), dash.indexOf('const items = section('));
  assert.match(block, /coverage-note/);
  assert.match(block, /coverageLine/);
});

/* ---------- P4: action-oriented opportunities ---------- */

test('every opportunity carries an imperative action heading', () => {
  for (const kind of ['knowledge-gap', 'unverified-rule', 'clarification-item',
                      'unhelpful-feedback']) {
    const i = analytics.indexOf(`kind: '${kind}'`);
    assert.ok(i > 0, `${kind} missing`);
    assert.match(analytics.slice(i, i + 400), /action: `/, `${kind} needs an action heading`);
  }
  assert.match(analytics, /action: 'Verify food-scrap collection at Evans Hall'/);
});

test('the card leads with the action and the next step, evidence underneath', () => {
  const render = dash.slice(dash.indexOf('function renderOpportunities'),
                            dash.indexOf("/* ---------- plumbing ----------"));
  assert.ok(render.indexOf('opp-action') < render.indexOf('opp-next'));
  assert.ok(render.indexOf('opp-next') < render.indexOf('opp-evidence'));
  assert.match(render, /Recommended next step/);
  assert.match(render, /<details|el\('details', 'opp-evidence'\)/);
  // The three opportunity types stay distinguishable.
  assert.match(render, /WasteWise knowledge gap/);
  assert.match(render, /Question for Facilities/);
  assert.match(render, /Answer quality/);
});

test('subject labels reuse destination colours without implying a destination', () => {
  assert.match(adminCss, /\.subj-food_waste\s*\{[^}]*var\(--c-food\)/);
  assert.match(analytics, /subject_label: 'Food scraps'/);
});

/* ---------- P5: fewer repetitions, same substance ---------- */

test('the long methodology note lives in one expandable place', () => {
  // The footer is now a single line pointing at the definitions.
  const footer = dashHtml.slice(dashHtml.indexOf('<footer'), dashHtml.indexOf('</footer>'));
  assert.ok(footer.length < 400, 'the footer should be short');
  assert.match(footer, /not students, and not disposal/);
  assert.match(footer, /How these numbers work/);
  // ...and the substance survives in the definitions list.
  assert.match(dash, /Questions, items and students/);
  assert.match(dash, /What this cannot measure/);
  assert.match(dash, /no accounts or sessions/);
  assert.match(dash, /contamination, diversion, or any change in behaviour/);
});

test('development traffic is still called out wherever it is included', () => {
  assert.match(dash, /COHORT_TEXT/);
  assert.match(dash, /not as observations of student behaviour/);
  assert.match(dash, /mixes development testing with real usage/);
  assert.match(dashHtml, /id="cohort-banner"/);
});

/* ---------- P6: feedback and accessibility ---------- */

test('feedback uses muted green and red', () => {
  assert.match(adminCss, /\.bar-fill\.f-helpful\s*\{[^}]*#4a8f58/);
  assert.match(adminCss, /\.bar-fill\.f-not\s*\{[^}]*#b8674b/);
  assert.match(dash, /tone: 'f-helpful'/);
  assert.match(dash, /tone: 'f-not'/);
});

test('charts keep their accessible alternatives', () => {
  assert.match(dash, /chart\.setAttribute\('role', 'img'\)/);
  assert.match(dash, /View the daily figures/);
  assert.match(dash, /aria-label/);
});

test('the brand identity and responsive layout are preserved', () => {
  assert.equal(tokenValue(adminCss, '--green'), tokenValue(studentCss, '--green'));
  assert.equal(tokenValue(adminCss, '--bg'), tokenValue(studentCss, '--bg'));
  assert.match(adminCss, /@media \(max-width: 620px\)/);
  assert.match(adminCss, /overflow-wrap: anywhere/);
  assert.match(dashHtml, /role="tablist"/);
});

/* ---------- Final polish pass: KPI formatting, chart height, link, latency ---------- */

/**
 * dashboard.js is browser code with no module boundary, so a named helper is
 * lifted out of the source and exercised directly. That keeps these assertions
 * behavioural rather than another string match on the file.
 */
function lift(name) {
  const start = dash.indexOf(`const ${name} =`) >= 0
    ? dash.indexOf(`const ${name} =`)
    : dash.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in dashboard.js`);
  // Read forward to the end of the declaration by balancing braces.
  let depth = 0, seen = false, end = start;
  for (let i = start; i < dash.length; i += 1) {
    if (dash[i] === '{') { depth += 1; seen = true; }
    else if (dash[i] === '}') { depth -= 1; if (seen && depth === 0) { end = i + 1; break; } }
  }
  const src = dash.slice(start, end);
  // UNAVAILABLE is a module-level constant the lifted helper closes over.
  return new Function('UNAVAILABLE', `${src}\nreturn ${name};`)(/\bUNAVAILABLE = '([^']+)'/.exec(dash)[1]);
}

test('large token counts are abbreviated, small ones are not', () => {
  const compactNum = lift('compactNum');
  assert.equal(compactNum(385_700), '385.7K');
  assert.equal(compactNum(101_000), '101K');
  assert.equal(compactNum(1_250_000), '1.3M');
  assert.equal(compactNum(9_999), '9,999');   // below the threshold, shown exactly
  assert.equal(compactNum(0), '0');
  assert.equal(compactNum(null), '—');
  // Never long enough to wrap the KPI value onto a second line.
  for (const v of [385_700, 101_000, 1_250_000, 999_999_999]) {
    assert.ok(compactNum(v).length <= 6, `${compactNum(v)} is too long`);
  }
});

test('the exact token counts stay on the card beside the abbreviation', () => {
  assert.match(dash, /card\('AI tokens',\s*\n\s*`\$\{compactNum\(data\.tokens\.input\)\} in/);
  assert.match(dash, /`\$\{num\(data\.tokens\.input\)\} in \/ \$\{num\(data\.tokens\.output\)\} out`/);
  // Reachable without a pointer: rendered as text, not only as a title tooltip.
  assert.match(dash, /c\.append\(el\('span', 'kpi-note kpi-exact', exact\)\)/);
});

test('sub-second response times are never shown as 0.0s', () => {
  const formatLatency = lift('formatLatency');
  assert.equal(formatLatency(4), '4 ms');      // the real median in the database
  assert.equal(formatLatency(0), '<1 ms');     // measured, but under a millisecond
  assert.equal(formatLatency(42), '42 ms');
  assert.equal(formatLatency(2300), '2.3s');
  for (const ms of [0, 1, 4, 42, 99, 999]) {
    assert.notEqual(formatLatency(ms), '0.0s', `${ms}ms must not render as 0.0s`);
  }
});

test('missing timing data is reported as missing, not as zero', () => {
  const formatLatency = lift('formatLatency');
  assert.equal(formatLatency(null), 'Not measured');
  assert.equal(formatLatency(undefined), 'Not measured');
});

test('the daily chart is shorter but bars stay visible at every count', () => {
  const height = (css) => Number(/\.chart \{[^}]*height:\s*(\d+)px/.exec(css)?.[1]);
  const desktop = height(adminCss);
  assert.ok(desktop >= 110 && desktop <= 120, `expected ~115px, got ${desktop}px`);
  assert.ok(desktop <= 150 * 0.8 + 6 && desktop >= 150 * 0.75 - 6,
    'reduction should be roughly 20–25% from the original 150px');
  // A zero or near-zero day still paints something.
  assert.match(adminCss, /\.chart-bar \{[^}]*min-height:\s*[1-9]/);
  assert.match(adminCss, /\.chart-bar\.is-zero \{/);
  // The figures table stays available.
  assert.match(adminCss, /\.chart-table summary \{/);
});

test('the methodology link uses the WasteWise green with an accessible focus state', () => {
  const green = tokenValue(adminCss, '--green');
  assert.equal(green, '#0f4d3a');
  const rule = /\.ops-foot a \{([^}]*)\}/.exec(adminCss)?.[1] ?? '';
  assert.match(rule, /color:\s*var\(--green\)/, 'link must be forest green, not browser blue');
  assert.match(rule, /text-decoration:\s*underline/, 'underline must be kept');
  assert.match(adminCss, /\.ops-foot a:hover \{/, 'needs a hover state');
  assert.match(adminCss, /\.ops-foot a:focus-visible \{[^}]*outline:/, 'needs a visible focus ring');
  // The link the rule targets is still in the markup and still points at the panel.
  assert.match(dashHtml, /id="methodology-link"/);
  assert.match(dashHtml, /href="#definitions-toggle"/);
});
