/*
 * Operations dashboard.
 *
 * Every value rendered here comes from an admin API response. Text that
 * originated with a student — item identifications, feedback comments — is
 * always written with textContent, never interpolated into markup.
 */

const $ = (sel) => document.querySelector(sel);
let range = '7d';
let cohort = 'operational';
const cache = {};

const COHORT_TEXT = {
  operational: 'Student evaluation and public usage. Development testing is excluded.',
  student_eval: 'Structured evaluation sessions only.',
  public: 'Organic public usage only.',
  development: 'The author\u2019s own testing. These are not student questions and say nothing about student behaviour.',
  all: 'Every record, including development testing.',
};

/* ---------- small DOM helpers (no innerHTML for data) ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const num = (v) => (v === null || v === undefined ? '—' : v.toLocaleString());
const UNAVAILABLE = 'Not measured';

/**
 * Large counts are abbreviated so the KPI value stays on one line at every
 * width. The exact figure is kept alongside, never replaced.
 */
const compactNum = (v) => {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs < 10_000) return v.toLocaleString();
  const [divisor, suffix] = abs >= 1_000_000 ? [1_000_000, 'M'] : [1_000, 'K'];
  // One decimal, trailing .0 dropped, so the string never exceeds six characters.
  const text = (v / divisor).toFixed(1).replace(/\.0$/, '');
  return `${text}${suffix}`;
};

/**
 * Response times are recorded in whole milliseconds. Deterministic answers come
 * back in single-digit milliseconds, which `0.0s` misrepresents as nothing at
 * all, so sub-second values are shown in the unit they were measured in. A
 * recorded 0 means "under a millisecond", which is different from no data: that
 * case is `null` and says so.
 */
function formatLatency(ms) {
  if (ms === null || ms === undefined) return UNAVAILABLE;
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function card(title, value, note, variant = '', exact = '') {
  const c = el('div', `kpi${variant ? ` ${variant}` : ''}`);
  const valueNode = el('strong', 'kpi-value', value);
  // The abbreviated value carries the full figure as a tooltip, and repeats it
  // as supporting text below so it is reachable without a pointer.
  if (exact) valueNode.title = exact;
  c.append(el('span', 'kpi-label', title), valueNode);
  if (exact) c.append(el('span', 'kpi-note kpi-exact', exact));
  if (note) c.append(el('span', 'kpi-note', note));
  return c;
}

/**
 * Cost is only meaningful if every question in the period has a rate. Most do
 * not, so say that rather than summing to a confident-looking zero.
 */
function costNote(cost, queries) {
  if (!cost || !queries) return 'No questions in this period';
  if (cost.priced_queries === 0) return 'Cost not calculable — no rate card configured';
  if (cost.priced_queries < queries) {
    return `Cost known for ${num(cost.priced_queries)} of ${num(queries)} questions only`;
  }
  return `Estimated $${cost.total_usd.toFixed(4)}`;
}

function emptyState(message) {
  const box = el('div', 'ops-empty');
  box.append(el('p', null, message));
  return box;
}

function section(title, subtitle) {
  const s = el('section', 'ops-card');
  s.append(el('h2', null, title));
  if (subtitle) s.append(el('p', 'ops-sub', subtitle));
  return s;
}

/** Simple horizontal bars — readable, and backed by a real table of figures. */
function barList(rows, { labelKey = 'name', valueKey = 'count', formatter = num, tone } = {}) {
  const total = rows.reduce((a, r) => a + (r[valueKey] ?? 0), 0);
  const wrap = el('div', 'bars');
  if (!rows.length) return emptyState('No data in this period.');
  for (const r of rows) {
    const row = el('div', 'bar-row');
    row.append(el('span', 'bar-label', r[labelKey] ?? 'unrecorded'));
    const track = el('div', 'bar-track');
    // Colour is an extra cue only — the label and count carry the meaning.
    const fill = el('div', `bar-fill${tone ? ` ${tone(r)}` : ''}`);
    fill.style.width = total ? `${Math.max(2, ((r[valueKey] ?? 0) / total) * 100)}%` : '0%';
    track.append(fill);
    row.append(track, el('span', 'bar-value', formatter(r[valueKey])));
    wrap.append(row);
  }
  return wrap;
}

/**
 * Compact stacked bar plus a legend carrying the exact counts and shares.
 * The stack is decoration over the legend, which is the real table of figures.
 */
function stackedDistribution(rows, { labelFor, toneFor, colourFor }) {
  if (!rows.length) return emptyState('No items in this period.');
  const total = rows.reduce((a, r) => a + r.count, 0);
  const wrap = el('div');

  const stack = el('div', 'stack');
  stack.setAttribute('role', 'img');
  stack.setAttribute('aria-label',
    rows.map((r) => `${labelFor(r)}: ${r.count} of ${total}`).join('; '));
  for (const r of rows) {
    const seg = el('div', `stack-seg ${toneFor(r)}`);
    seg.style.width = `${(r.count / total) * 100}%`;
    seg.style.background = colourFor(r);
    seg.title = `${labelFor(r)}: ${r.count}`;
    stack.append(seg);
  }
  wrap.append(stack);

  const legend = el('div', 'legend');
  for (const r of rows) {
    const row = el('div', 'legend-row');
    const sw = el('span', 'legend-swatch');
    sw.style.background = colourFor(r);
    row.append(sw, el('span', 'legend-label', labelFor(r)),
      el('span', 'legend-count', num(r.count)),
      el('span', 'legend-pct', pct(r.count / total)));
    legend.append(row);
  }
  wrap.append(legend);
  return wrap;
}

/** Resolved from the stylesheet, so there is one source of truth for colour. */
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const DEST_COLOUR = {
  recycling: '--c-recycling', trash: '--c-trash', food_waste: '--c-food',
  return_dishware: '--c-dish', special: '--c-special', unknown: '--c-open',
  multiple: '--c-open', unrecorded: '--line',
};

/* ---------- overview ---------- */

function renderDailyChart(days) {
  const host = $('#daily-chart');
  host.replaceChildren();
  if (!days.length || days.every((d) => d.queries === 0)) {
    host.append(emptyState('No questions recorded in this period.'));
    return;
  }
  const max = Math.max(...days.map((d) => d.queries), 1);
  const chart = el('div', 'chart');
  chart.setAttribute('role', 'img');
  chart.setAttribute(
    'aria-label',
    `Questions per day from ${days[0].day} to ${days[days.length - 1].day}, peak ${max} in a day.`,
  );
  for (const d of days) {
    const col = el('div', 'chart-col');
    col.title = `${d.day}: ${d.queries} question${d.queries === 1 ? '' : 's'}`;
    const bar = el('div', 'chart-bar');
    bar.style.height = `${(d.queries / max) * 100}%`;
    if (d.queries === 0) bar.classList.add('is-zero');
    col.append(bar);
    chart.append(col);
  }
  host.append(chart);

  const caption = el('div', 'chart-axis');
  caption.append(el('span', null, days[0].day), el('span', null, days[days.length - 1].day));
  host.append(caption);

  // Accessible, exact alternative to the bars.
  const details = el('details', 'chart-table');
  details.append(el('summary', null, 'View the daily figures'));
  const table = el('table');
  const head = el('tr');
  for (const h of ['Day', 'Questions', 'Photo', 'Unresolved']) head.append(el('th', null, h));
  table.append(head);
  for (const d of days) {
    const tr = el('tr');
    tr.append(el('td', null, d.day), el('td', null, d.queries),
      el('td', null, d.photo), el('td', null, d.unresolved));
    table.append(tr);
  }
  details.append(table);
  host.append(details);
}

function renderOverview(data) {
  const k = $('#kpis');
  k.replaceChildren();
  k.append(
    // The two cards an administrator acts on lead, at double width.
    card('Questions asked', num(data.queries), 'Questions, not unique students',
      'kpi-primary'),
    card('Unresolved', num(data.unresolved),
      data.unresolved_share === null
        ? 'No questions in this period'
        : `${pct(data.unresolved_share)} of questions had no recommendation`,
      'kpi-primary kpi-attention'),
    card('Photo questions', num(data.photo_queries),
      data.photo_share === null ? 'No data' : `${pct(data.photo_share)} of questions`),
    card('Text questions', num(data.text_queries)),
    card('Clarifications asked', num(data.clarifications)),
    card('Feedback responses', num(data.feedback.total),
      data.feedback.total ? `${pct(data.feedback.helpful_share)} marked helpful` : 'None yet'),
    card('AI tokens',
      `${compactNum(data.tokens.input)} in / ${compactNum(data.tokens.output)} out`,
      costNote(data.cost, data.queries), '',
      `${num(data.tokens.input)} in / ${num(data.tokens.output)} out`),
    card('Median response time',
      formatLatency(data.latency.median_ms),
      data.latency.samples === 0
        ? 'Only recorded from this release onward'
        : `${num(data.latency.samples)} of ${num(data.queries)} questions measured`),
  );

  renderDailyChart(data.daily ?? []);

  const defs = $('#definitions');
  defs.replaceChildren();
  const entries = [
    ['Questions asked', 'One row per submission to the assistant. Repeat questions are counted separately; there are no accounts, so they cannot be attributed to a person.'],
    ['Unresolved', 'The assistant declined to name a bin, either because no cited rule covered the item or because a detail was missing.'],
    ['Clarifications asked', 'Answers that included a follow-up question. Some of these still carried a provisional recommendation.'],
    ['Feedback responses', 'Yes/No answers to “Was this helpful?”. This reflects how the answer felt, not whether the sorting guidance is correct.'],
    ['Median response time', 'End-to-end server time, measured in whole milliseconds. Deterministic answers return in milliseconds and are shown in that unit; only slower answers are shown in seconds. Only recorded for questions asked after this dashboard was added, so coverage is partial.'],
    ['Questions, items and students', 'A question is one submission. An item is one thing inside a question — a photo of three things is one question and three items, so the two scopes have different denominators. Neither is a count of students: WasteWise has no accounts or sessions, so repeat questions cannot be attributed to one person.'],
    ['What this cannot measure', 'Nothing here records what was actually put in a bin. There is no measurement of contamination, diversion, or any change in behaviour — only what students asked and how WasteWise answered.'],
  ];
  for (const [term, meaning] of entries) {
    defs.append(el('dt', null, term), el('dd', null, meaning));
  }
}

/* ---------- insights ---------- */

const DEST_LABEL = {
  recycling: 'Recycling', trash: 'Trash', food_waste: 'Food scraps',
  return_dishware: 'Return / reuse', special: 'Special handling',
  unknown: 'Unresolved', multiple: 'Multiple items (not itemised)',
  unrecorded: 'Not recorded',
};

/**
 * Grouped items, each expandable to the exact descriptions behind it, so a
 * merge can always be inspected rather than taken on trust.
 */
function groupedList(groups) {
  if (!groups.length) return emptyState('No items in this period.');
  const total = groups.reduce((a, g) => a + g.count, 0);
  const wrap = el('div', 'bars');
  for (const g of groups) {
    const row = el('details', 'group-row');
    const sum = el('summary');
    sum.append(el('span', 'bar-label', g.name));
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = total ? `${Math.max(2, (g.count / total) * 100)}%` : '0%';
    track.append(fill);
    sum.append(track, el('span', 'bar-value', num(g.count)));
    row.append(sum);

    const body = el('div', 'group-body');
    body.append(el('p', 'group-how', `Grouped by ${g.grouped_by}${g.rule_id ? ` (${g.rule_id})` : ''}.`));
    if (g.unresolved || g.clarifications) {
      body.append(el('p', 'group-how',
        `${num(g.unresolved)} unresolved · ${num(g.clarifications)} needed a follow-up.`));
    }
    const ul = el('ul', 'group-variants');
    for (const v of g.variants) {
      ul.append(el('li', null, `${v.description} — ${v.count}`));
    }
    body.append(ul);
    row.append(body);
    wrap.append(row);
  }
  return wrap;
}

function scopeTag(text) {
  return el('span', 'scope-tag', text);
}

/** A visible caution whenever a share rests on part of the period. */
function coverageNote(known, total, what) {
  if (total === 0 || known === total) return null;
  return el('p', 'coverage-note',
    `Based on ${num(known)} of ${num(total)} ${what}. The rest were recorded before per-item outcomes were stored, so they cannot be counted here.`);
}

function renderInsights(data) {
  const host = $('#insights-body');
  host.replaceChildren();

  const q = data.query_level;
  const it = data.item_level;

  if (!q.queries) {
    host.append(emptyState('No questions recorded in this period.'));
    return;
  }

  /* --- query level: one row per question asked --- */
  const chan = section('Photo compared with typed questions',
    'One row per question asked. Counts cover every question in the period.');
  chan.querySelector('h2').append(scopeTag('Query level'));

  const grid = el('div', 'split');
  for (const [label, c, noun] of [['Photo questions', q.photo, 'photo'],
                                  ['Typed questions', q.text, 'typed']]) {
    const b = el('div', 'split-box');
    b.append(el('span', 'kpi-label', label), el('strong', 'kpi-value', num(c.queries)));
    /*
     * Counts, not a bare percentage. "100% unresolved" read as a verdict on
     * every photo when it rested on a seventh of them; "7 of 7 eligible"
     * cannot be misread that way, and the coverage line sits right beneath it.
     */
    b.append(el('span', 'kpi-note',
      c.outcome_known === 0
        ? 'No outcome data recorded for these yet'
        : `${num(c.unresolved)} of ${num(c.outcome_known)} eligible ${noun} questions unresolved`));
    if (c.outcome_known > 0 && c.outcome_known < c.queries) {
      b.append(el('span', 'kpi-note coverage-inline',
        `Outcome data available for ${num(c.outcome_known)} of ${num(c.queries)} ${noun} questions (${pct(c.outcome_coverage)} coverage).`));
    }
    b.append(el('span', 'kpi-note',
      c.clarification_share === null ? '' : `${pct(c.clarification_share)} asked a follow-up`));
    grid.append(b);
  }
  chan.append(grid);
  host.append(chan);

  /* --- item level: one row per item inside a question --- */
  const coverageLine = it.excluded_queries
    ? `Based on ${num(it.contributing_queries)} of ${num(it.total_queries)} questions (${pct(it.coverage)}).`
    : `Based on all ${num(it.total_queries)} questions in this period.`;

  const dest = section('Where items were directed',
    `${num(it.items)} items. A photo of several things contributes one row per item.`);
  dest.querySelector('h2').append(scopeTag('Item level'));
  if (it.excluded_queries) {
    dest.append(el('p', 'coverage-note',
      `${coverageLine} ${num(it.excluded_queries)} multi-item photo${it.excluded_queries === 1 ? '' : 's'} predate per-item storage and cannot be broken down.`));
  }
  dest.append(stackedDistribution(it.destinations, {
    labelFor: (d) => DEST_LABEL[d.name] ?? d.name,
    toneFor: (d) => `d-${d.name}`,
    colourFor: (d) => cssVar(DEST_COLOUR[d.name] ?? '--muted'),
  }));
  host.append(dest);

  const items = section('Most asked about',
    `Grouped by the rule each question actually matched. ${num(it.grouped_by_rule)} group${it.grouped_by_rule === 1 ? '' : 's'} merged this way; ${num(it.ungrouped)} description${it.ungrouped === 1 ? '' : 's'} matched no rule and are listed on their own rather than merged by wording.`);
  items.querySelector('h2').append(scopeTag('Item level'));
  items.append(groupedList(it.top_items));
  host.append(items);

  const clar = section('Items that needed a follow-up question',
    'Candidates for clearer signage: a detail was missing at the bin.');
  clar.querySelector('h2').append(scopeTag('Item level'));
  clar.append(it.clarification_items.length
    ? barList(it.clarification_items.map((i) => ({ name: i.name, count: i.clarifications })))
    : emptyState('No clarification questions in this period.'));
  host.append(clar);

  const conf = section('Confidence of answers',
    'How settled each answer was. This is a different scale from destination and uses its own colours.');
  conf.querySelector('h2').append(scopeTag('Item level'));
  conf.append(barList(it.confidence, { tone: (r) => `c-${r.name}` }));
  host.append(conf);
}

/* ---------- feedback ---------- */

function renderFeedback(data) {
  const host = $('#feedback-body');
  host.replaceChildren();

  const totals = data.trend.reduce((a, d) => ({
    total: a.total + d.total, helpful: a.helpful + d.helpful,
  }), { total: 0, helpful: 0 });

  const summary = section('Helpful or not',
    'Feedback is about how the answer landed. It is not a check on whether the sorting guidance is correct.');
  if (!totals.total) {
    summary.append(emptyState('No feedback submitted in this period.'));
  } else {
    summary.append(barList([
      { name: 'Helpful', count: totals.helpful, tone: 'f-helpful' },
      { name: 'Not helpful', count: totals.total - totals.helpful, tone: 'f-not' },
    ], { tone: (r) => r.tone }));
  }
  host.append(summary);

  if (data.trend.length) {
    const trend = section('Feedback by day', null);
    const table = el('table', 'ops-table');
    const head = el('tr');
    for (const h of ['Day', 'Responses', 'Helpful']) head.append(el('th', null, h));
    table.append(head);
    for (const d of data.trend) {
      const tr = el('tr');
      tr.append(el('td', null, d.day), el('td', null, d.total), el('td', null, d.helpful));
      table.append(tr);
    }
    trend.append(table);
    host.append(trend);
  }

  const comments = section('Written comments',
    'Anonymous and visible to signed-in admins only. Treat as potentially identifying.');
  if (!data.comments.length) {
    comments.append(emptyState('No written comments in this period.'));
  } else {
    const list = el('div', 'comment-list');
    for (const c of data.comments) {
      const item = el('article', 'comment');
      const head = el('div', 'comment-head');
      head.append(el('span', `tag ${c.helpful ? 'tag-yes' : 'tag-no'}`,
        c.helpful ? 'Helpful' : 'Not helpful'));
      head.append(el('span', 'comment-meta', c.created_at.slice(0, 10)));
      item.append(head);
      // Student text: textContent only.
      item.append(el('p', 'comment-body', c.comment));
      const ctx = [c.identified_item, c.recommendation, c.had_image ? 'photo' : 'typed']
        .filter(Boolean).join(' · ');
      if (ctx) item.append(el('p', 'comment-ctx', `Answer context: ${ctx}`));
      list.append(item);
    }
    comments.append(list);
  }
  host.append(comments);
}

/* ---------- opportunities ---------- */

function renderOpportunities(data) {
  const host = $('#opportunities-body');
  host.replaceChildren();

  const intro = section('Opportunities to improve waste sorting',
    `Patterns found in ${num(data.sample_size)} recorded items, surfaced by fixed rules — not predictions, and not evidence that sorting behaviour changed. Each needs a human to confirm.`);
  if (data.development_only) {
    intro.append(el('p', 'coverage-note',
      'This cohort is the author\u2019s own development testing. Treat the patterns as checks on the knowledge base, not as observations of student behaviour.'));
  } else if (data.includes_development) {
    intro.append(el('p', 'coverage-note',
      'This view mixes development testing with real usage, so the patterns are not purely about students.'));
  }
  if (data.excluded_queries) {
    intro.append(el('p', 'coverage-note',
      `${num(data.excluded_queries)} multi-item photo${data.excluded_queries === 1 ? '' : 's'} recorded before per-item storage are not included in these patterns.`));
  }
  host.append(intro);

  if (data.limited_data) {
    host.append(emptyState(
      `Only ${num(data.sample_size)} item${data.sample_size === 1 ? '' : 's'} recorded for this cohort and period — fewer than the ${num(data.min_sample)} needed before patterns are worth reporting. Operational recommendations are withheld rather than overstated.`));
    return;
  }
  if (!data.opportunities.length) {
    host.append(emptyState(
      `Nothing met the threshold of ${data.min_observations} observations in this period. More questions will make patterns visible.`));
    return;
  }

  const TYPE_LABEL = {
    'knowledge-gap': 'WasteWise knowledge gap',
    'campus-question': 'Question for Facilities',
    signage: 'Signage opportunity',
    'answer-quality': 'Answer quality',
  };

  for (const o of data.opportunities) {
    const c = el('article', `opportunity opp-${o.type ?? 'general'}`);

    // 1. What needs attention.
    const head = el('div', 'opp-head');
    head.append(el('h3', 'opp-action', o.action ?? o.title));
    if (o.subject_label) {
      head.append(el('span', `opp-subject subj-${o.subject ?? 'trash'}`, o.subject_label));
    }
    head.append(el('span', 'opp-type', TYPE_LABEL[o.type] ?? 'Observation'));
    c.append(head);

    // 2. The recommended next step, given prominence.
    const next = el('div', 'opp-next');
    next.append(el('strong', null, 'Recommended next step'));
    next.append(el('span', null, o.next_step));
    c.append(next);

    // 3. Supporting evidence, available but not in the way.
    const ev = el('details', 'opp-evidence');
    ev.append(el('summary', null, 'Supporting evidence'));
    ev.append(el('p', null, o.observed));
    ev.append(el('p', null, o.why));
    c.append(ev);

    host.append(c);
  }
}

/* ---------- plumbing ---------- */

const LOADERS = {
  overview: ['/api/admin/overview', renderOverview],
  insights: ['/api/admin/insights', renderInsights],
  feedback: ['/api/admin/feedback', renderFeedback],
  opportunities: ['/api/admin/opportunities', renderOpportunities],
};

async function load(panel, { force = false } = {}) {
  const [url, render] = LOADERS[panel];
  const key = `${panel}:${range}:${cohort}`;
  try {
    if (force || !cache[key]) {
      const res = await fetch(
        `${url}?range=${encodeURIComponent(range)}&cohort=${encodeURIComponent(cohort)}`);
      if (res.status === 401) return window.location.replace('/admin');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not load data.');
      cache[key] = await res.json();
    }
    render(cache[key]);
  } catch (err) {
    const host = $(`#panel-${panel}`);
    host.replaceChildren(emptyState(err.message));
  }
}

function setRange(next) {
  range = next;
  document.querySelectorAll('[data-range]').forEach((b) => {
    const on = b.dataset.range === next;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const label = { '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' }[next];
  $('#range-note').textContent = `Showing ${label}`;
  load(currentPanel());
}

function setCohort(next) {
  cohort = next;
  document.querySelectorAll('[data-cohort]').forEach((b) => {
    const on = b.dataset.cohort === next;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#cohort-note').textContent = COHORT_TEXT[next] ?? '';
  // Development traffic is called out loudly, so a reader never mistakes the
  // author's own testing for student usage.
  const banner = $('#cohort-banner');
  const isDev = next === 'development' || next === 'all';
  banner.hidden = !isDev;
  banner.textContent = next === 'development'
    ? 'Showing development testing only — the author\u2019s own debugging and regression runs. Nothing here reflects student behaviour.'
    : 'This view includes development testing alongside any real usage, so totals are not a measure of student activity.';
  load(currentPanel());
}

const currentPanel = () =>
  document.querySelector('.ops-tab.is-active')?.dataset.panel ?? 'overview';

document.querySelectorAll('.ops-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ops-tab').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.ops-panel').forEach((p) => {
      p.classList.toggle('is-active', p.id === `panel-${tab.dataset.panel}`);
    });
    load(tab.dataset.panel);
  });
});

document.querySelectorAll('[data-range]').forEach((b) => {
  b.addEventListener('click', () => setRange(b.dataset.range));
});
document.querySelectorAll('[data-cohort]').forEach((b) => {
  b.addEventListener('click', () => setCohort(b.dataset.cohort));
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('/admin');
});

$('#methodology-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector('.ops-tab[data-panel="overview"]').click();
  const defs = $('#definitions-toggle');
  defs.open = true;
  defs.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

setCohort('operational');
setRange('7d');
