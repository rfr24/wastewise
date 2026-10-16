import db from './db.js';
import { loadRules } from './rules.js';
import { COHORT_FILTERS, COHORT_LABELS } from '../cohort.js';

/*
 * Aggregates for the operations dashboard.
 *
 * Every figure is computed from rows the assistant actually stored. Where the
 * data cannot support a metric the value is null and the dashboard says so —
 * nothing is estimated and no sample data is ever substituted.
 *
 * Two scopes are kept strictly apart. Query-level counts one row per question
 * asked; item-level counts one row per item inside a question. They have
 * different denominators and must never be read against each other.
 */

export const RANGES = { '7d': 7, '30d': 30, all: null };
export const DEFAULT_COHORT_FILTER = 'operational';

/** Inclusive lower bound as an ISO string, or null for "all time". */
export function rangeStart(range) {
  const days = RANGES[range];
  if (!days) return null;
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString();
}

/**
 * The WHERE clause shared by every query here. `alias` is the table alias
 * holding created_at and cohort — feedback has no cohort of its own and
 * inherits it by joining the query it belongs to.
 */
function filters(range, cohortKey, { alias = '', dateColumn = 'created_at' } = {}) {
  const start = rangeStart(range);
  const key = Object.hasOwn(COHORT_FILTERS, cohortKey) ? cohortKey : DEFAULT_COHORT_FILTER;
  const cohorts = COHORT_FILTERS[key];
  const a = alias ? `${alias}.` : '';
  const clauses = [`${a}cohort IN (${cohorts.map(() => '?').join(', ')})`];
  const params = [...cohorts];
  if (start) {
    clauses.push(`${a}${dateColumn} >= ?`);
    params.push(start);
  }
  return { start, cohortKey: key, cohorts, where: `WHERE ${clauses.join(' AND ')}`, params };
}

export const cohortSummary = () =>
  db.prepare('SELECT cohort, COUNT(*) AS queries FROM queries GROUP BY cohort')
    .all()
    .map((r) => ({ ...r, label: COHORT_LABELS[r.cohort] ?? r.cohort }));

/* ---------- overview ------------------------------------------------------ */

export function overview(range = 'all', cohort = DEFAULT_COHORT_FILTER) {
  const f = filters(range, cohort);
  const totals = db
    .prepare(`
      SELECT
        COUNT(*)                                            AS queries,
        COALESCE(SUM(had_image), 0)                         AS photo_queries,
        COALESCE(SUM(CASE WHEN recommendation = 'unknown' THEN 1 ELSE 0 END), 0) AS unresolved,
        COALESCE(SUM(needs_clarification), 0)               AS clarifications,
        COALESCE(SUM(input_tokens), 0)                      AS input_tokens,
        COALESCE(SUM(output_tokens), 0)                     AS output_tokens,
        SUM(estimated_cost_usd)                             AS estimated_cost_usd,
        COUNT(estimated_cost_usd)                           AS priced_queries,
        COUNT(latency_ms)                                   AS latency_samples,
        AVG(latency_ms)                                     AS latency_mean_ms
      FROM queries ${f.where}
    `)
    .get(...f.params);

  const latencies = db
    .prepare(`SELECT latency_ms FROM queries ${f.where} AND latency_ms IS NOT NULL
              ORDER BY latency_ms`)
    .all(...f.params)
    .map((r) => r.latency_ms);
  const median = latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null;

  // Feedback has no cohort column; it inherits the cohort of its query.
  const ff = filters(range, cohort, { alias: 'q' });
  const fb = db
    .prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(f.helpful), 0) AS helpful,
             COUNT(f.comment) AS with_comment
      FROM feedback f JOIN queries q ON q.id = f.query_id ${ff.where}
    `)
    .get(...ff.params);

  const q = totals.queries;
  return {
    range,
    cohort: f.cohortKey,
    cohorts: f.cohorts,
    range_start: f.start,
    queries: q,
    photo_queries: totals.photo_queries,
    text_queries: q - totals.photo_queries,
    photo_share: q ? totals.photo_queries / q : null,
    unresolved: totals.unresolved,
    unresolved_share: q ? totals.unresolved / q : null,
    clarifications: totals.clarifications,
    feedback: {
      total: fb.total,
      helpful: fb.helpful,
      not_helpful: fb.total - fb.helpful,
      helpful_share: fb.total ? fb.helpful / fb.total : null,
      with_comment: fb.with_comment,
    },
    tokens: { input: totals.input_tokens, output: totals.output_tokens },
    /*
     * Most rows carry no cost: no rate card is published for the course model,
     * so only rule-matched answers (which genuinely cost nothing) are priced.
     * Coverage travels with the figure so the UI can withhold a false "$0.00".
     */
    cost: {
      total_usd: totals.estimated_cost_usd,
      priced_queries: totals.priced_queries,
      coverage: q ? totals.priced_queries / q : null,
    },
    latency: {
      samples: totals.latency_samples,
      mean_ms: totals.latency_mean_ms ? Math.round(totals.latency_mean_ms) : null,
      median_ms: median,
      coverage: q ? totals.latency_samples / q : null,
    },
  };
}

/** One bucket per day across the range, including days with no traffic. */
export function daily(range = 'all', cohort = DEFAULT_COHORT_FILTER) {
  const f = filters(range, cohort);
  const rows = db
    .prepare(`
      SELECT substr(created_at, 1, 10) AS day,
             COUNT(*) AS queries,
             COALESCE(SUM(had_image), 0) AS photo,
             COALESCE(SUM(CASE WHEN recommendation = 'unknown' THEN 1 ELSE 0 END), 0) AS unresolved
      FROM queries ${f.where}
      GROUP BY day ORDER BY day
    `)
    .all(...f.params);
  if (!f.start) return rows;

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  const cursor = new Date(f.start);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  while (cursor <= today) {
    const day = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, queries: 0, photo: 0, unresolved: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/* ---------- item-level rows ---------------------------------------------- */

/**
 * One row per item. Multi-item photos are stored as child rows, so prefer
 * those and fall back to the parent row for single-item and typed questions.
 */
function itemRows(range, cohort) {
  const child = filters(range, cohort, { alias: 'q' });
  const parent = filters(range, cohort, { alias: 'q' });
  return db
    .prepare(`
      SELECT qi.identified_item AS item, qi.category, qi.recommendation, qi.confidence,
             qi.needs_clarification, qi.rule_ids, q.had_image
      FROM query_items qi JOIN queries q ON q.id = qi.query_id ${child.where}
      UNION ALL
      SELECT q.identified_item, q.category, q.recommendation, q.confidence,
             q.needs_clarification, q.matched_rule_ids, q.had_image
      FROM queries q ${parent.where}
        AND q.recommendation <> 'multiple'
        AND NOT EXISTS (SELECT 1 FROM query_items qi WHERE qi.query_id = q.id)
    `)
    .all(...child.params, ...parent.params);
}

/** How much of the period the item-level breakdown can speak for. */
function itemCoverage(range, cohort) {
  const f = filters(range, cohort, { alias: 'q' });
  const total = db.prepare(`SELECT COUNT(*) n FROM queries q ${f.where}`).get(...f.params).n;
  const contributing = db
    .prepare(`
      SELECT COUNT(*) n FROM queries q ${f.where}
        AND (EXISTS (SELECT 1 FROM query_items qi WHERE qi.query_id = q.id)
             OR q.recommendation <> 'multiple')
    `)
    .get(...f.params).n;
  return {
    total_queries: total,
    contributing_queries: contributing,
    // Multi-item photos recorded before per-item storage existed. Their
    // destinations were never kept and cannot be reconstructed.
    excluded_queries: total - contributing,
    coverage: total ? contributing / total : null,
  };
}

/* ---------- conservative item grouping ------------------------------------ */

const firstRuleId = (json) => {
  try {
    const ids = JSON.parse(json ?? '[]');
    return Array.isArray(ids) && ids.length ? ids[0] : null;
  } catch {
    return null;
  }
};

/**
 * Group equivalent items using the structured evidence already recorded.
 *
 * The grouping key is the rule the assistant actually matched — a decision made
 * against the knowledge base, not from the wording of a description. So several
 * ways of saying "plastic wrapper" collapse only when they all matched the
 * verified plastic-film rule. Anything that matched no rule, including a bare
 * "plastic packaging" the assistant could not place, keeps its own row: merging
 * those on wording alone would invent a classification the data cannot support.
 *
 * Original descriptions are kept as variants so a reader can drill down.
 */
export function groupItems(rows) {
  const { rules } = loadRules();
  const byRule = new Map(rules.map((r) => [r.id, r]));
  const groups = new Map();

  for (const r of rows) {
    if (!r.item) continue;
    const ruleId = firstRuleId(r.rule_ids);
    const rule = ruleId ? byRule.get(ruleId) : null;
    const key = rule ? `rule:${rule.id}` : `label:${r.item.trim().toLowerCase()}`;

    const g = groups.get(key) ?? {
      key,
      // A matched rule contributes the curated name; otherwise the assistant's
      // own wording stands, unmerged.
      name: rule ? rule.item : r.item,
      grouped_by: rule ? 'matched rule' : 'exact description',
      rule_id: rule?.id ?? null,
      count: 0,
      unresolved: 0,
      clarifications: 0,
      variants: new Map(),
    };
    g.count += 1;
    if (r.recommendation === 'unknown') g.unresolved += 1;
    if (r.needs_clarification) g.clarifications += 1;
    g.variants.set(r.item, (g.variants.get(r.item) ?? 0) + 1);
    groups.set(key, g);
  }

  return [...groups.values()]
    .map(({ key, ...g }) => ({
      ...g,
      variants: [...g.variants]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([description, count]) => ({ description, count })),
    }))
    .sort((a, b) => b.count - a.count);
}

/* ---------- sorting insights --------------------------------------------- */

/** Query-level channel comparison, using every eligible query. */
function queryChannels(range, cohort) {
  const f = filters(range, cohort);
  const rows = db
    .prepare(`SELECT had_image, recommendation, needs_clarification FROM queries ${f.where}`)
    .all(...f.params);

  const summarise = (subset) => {
    const determinate = subset.filter((r) => r.recommendation && r.recommendation !== 'multiple');
    const unresolved = determinate.filter((r) => r.recommendation === 'unknown').length;
    const clarifications = subset.filter((r) => r.needs_clarification).length;
    return {
      queries: subset.length,
      outcome_known: determinate.length,
      unresolved: determinate.length ? unresolved : null,
      unresolved_share: determinate.length ? unresolved / determinate.length : null,
      outcome_coverage: subset.length ? determinate.length / subset.length : null,
      clarifications,
      clarification_share: subset.length ? clarifications / subset.length : null,
    };
  };

  const photo = rows.filter((r) => r.had_image);
  const text = rows.filter((r) => !r.had_image);
  return {
    queries: rows.length,
    photo: summarise(photo),
    text: summarise(text),
    photo_share: rows.length ? photo.length / rows.length : null,
  };
}

export function insights(range = 'all', cohort = DEFAULT_COHORT_FILTER) {
  const rows = itemRows(range, cohort);
  const groups = groupItems(rows);

  const tally = (key) => {
    const m = new Map();
    for (const r of rows) {
      const v = r[key] ?? 'unrecorded';
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };

  return {
    range,
    cohort: filters(range, cohort).cohortKey,
    query_level: queryChannels(range, cohort),
    item_level: {
      items: rows.length,
      ...itemCoverage(range, cohort),
      destinations: tally('recommendation'),
      categories: tally('category'),
      confidence: tally('confidence'),
      top_items: groups.slice(0, 15),
      clarification_items: groups
        .filter((g) => g.clarifications > 0)
        .sort((a, b) => b.clarifications - a.clarifications)
        .slice(0, 10),
      grouped_by_rule: groups.filter((g) => g.rule_id).length,
      ungrouped: groups.filter((g) => !g.rule_id).length,
    },
  };
}

/* ---------- feedback ------------------------------------------------------ */

export function feedbackDetail(range = 'all', cohort = DEFAULT_COHORT_FILTER) {
  const f = filters(range, cohort, { alias: 'q' });
  const trend = db
    .prepare(`
      SELECT substr(f.created_at, 1, 10) AS day,
             COUNT(*) AS total, COALESCE(SUM(f.helpful), 0) AS helpful
      FROM feedback f JOIN queries q ON q.id = f.query_id ${f.where}
      GROUP BY day ORDER BY day
    `)
    .all(...f.params);

  // Shown to an authenticated admin only, with the answer it refers to for
  // context. Free text is treated as potentially identifying.
  const comments = db
    .prepare(`
      SELECT f.created_at, f.helpful, f.comment, q.cohort,
             q.identified_item, q.recommendation, q.confidence, q.had_image
      FROM feedback f JOIN queries q ON q.id = f.query_id ${f.where}
        AND f.comment IS NOT NULL
      ORDER BY f.id DESC LIMIT 100
    `)
    .all(...f.params);

  return { range, cohort: f.cohortKey, trend, comments };
}

/* ---------- opportunities ------------------------------------------------- */

const MIN_OBSERVATIONS = Number(process.env.OPPORTUNITY_MIN_OBSERVATIONS ?? 3);
const MIN_SAMPLE = Number(process.env.OPPORTUNITY_MIN_SAMPLE ?? 10);

/**
 * Rules describing one operational question get one card between them.
 * Flagging "leftover food" and "compost collection in Evans Hall" separately
 * produced two cards pointing at the same conversation with Facilities.
 */
const THEMES = {
  'evans-food-waste': {
    rules: ['food-scraps', 'evans-compost-availability', 'charleys-food-scraps-bin'],
    action: 'Verify food-scrap collection at Evans Hall',
    subject: 'food_waste',
    subject_label: 'Food scraps',
    title: 'Food scraps in Evans Hall: collection is still unconfirmed',
    type: 'campus-question',
    why: 'Yale publishes that its food-waste programme serves dining halls and Hospitality retail spaces, and that it has no capacity for non-dining spaces. Evans Hall is not named either way, so WasteWise can describe the bin posted at Charley’s Place but cannot say what is collected from it.',
    next_step: 'Ask SOM Facilities to confirm whether the Charley’s Place food-scraps bin is collected and by whom. A written answer would turn a recurring caveat into one verified rule.',
  },
  'compostable-conflict': {
    rules: ['compostable-serviceware', 'charleys-compostable-signage'],
    title: 'Compostable serviceware: the Charley’s sign conflicts with Yale guidance',
    type: 'campus-question',
    why: 'Yale publishes that compostable cups, plates and utensils belong in the trash, while the sign photographed at Charley’s Place lists them as accepted. A student reading the sign gets different guidance from one reading Yale’s site.',
    next_step: 'Raise the discrepancy with SOM Facilities and Yale Hospitality. Whichever is correct, the sign or the published rule should change so the two agree.',
  },
};

const ruleTheme = (id) =>
  Object.entries(THEMES).find(([, t]) => t.rules.includes(id))?.[0] ?? null;

/**
 * Deterministic, explainable patterns — no model call. Each card states what
 * the recorded data shows, why it might matter and a practical next step.
 * These are prompts for a human to investigate, never findings about disposal
 * behaviour, contamination, or whether anything improved.
 */
export function opportunities(range = 'all', cohort = DEFAULT_COHORT_FILTER) {
  const f = filters(range, cohort);
  const rows = itemRows(range, cohort);
  const groups = groupItems(rows);
  const coverage = itemCoverage(range, cohort);
  const developmentOnly = f.cohorts.length === 1 && f.cohorts[0] === 'development';

  const base = {
    range,
    cohort: f.cohortKey,
    min_observations: MIN_OBSERVATIONS,
    min_sample: MIN_SAMPLE,
    sample_size: rows.length,
    ...coverage,
    // Development traffic is the author's own testing; it says nothing about
    // how students behave.
    development_only: developmentOnly,
    includes_development: f.cohorts.includes('development'),
  };

  if (rows.length < MIN_SAMPLE) {
    return { ...base, limited_data: true, opportunities: [] };
  }

  const out = [];
  const { rules } = loadRules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  const themeHits = new Map();

  for (const g of groups) {
    const theme = g.rule_id ? ruleTheme(g.rule_id) : null;
    if (theme) {
      const t = themeHits.get(theme) ?? { count: 0, unresolved: 0 };
      t.count += g.count;
      t.unresolved += g.unresolved;
      themeHits.set(theme, t);
      continue;                       // consolidated below, as one card
    }
    if (g.count < MIN_OBSERVATIONS) continue;

    const rule = g.rule_id ? byId.get(g.rule_id) : null;
    if (!rule && g.unresolved / g.count >= 0.5) {
      out.push({
        kind: 'knowledge-gap',
        type: 'knowledge-gap',
        action: `Add a sourced rule for “${g.name}”`,
        title: `No rule covers “${g.name}”`,
        observed: `Asked ${g.count} times; ${g.unresolved} ended without a recommendation.`,
        why: 'This is a gap in WasteWise’s own knowledge base rather than evidence of a problem with campus waste management — the assistant had nothing cited to answer from.',
        next_step: 'Check Yale Recycling and the RecycleCT list for this item. If either covers it, add a verified rule; if neither does, it is a genuine question for Facilities.',
      });
    } else if (rule && rule.verification_status === 'unverified') {
      out.push({
        kind: 'unverified-rule',
        type: 'knowledge-gap',
        action: `Find a published source for “${rule.item}”`,
        title: `No published source settles “${rule.item}”`,
        observed: `${g.count} questions reached this rule, which neither Yale nor Connecticut guidance resolves.`,
        why: 'Students asking about this item cannot get a confident answer however they phrase the question. The limitation is in the available guidance, not in the sorting logic.',
        next_step: 'Look for an authoritative source, or ask SOM Facilities whether campus practice differs from the statewide list.',
      });
    } else if (g.clarifications / g.count >= 0.5) {
      out.push({
        kind: 'clarification-item',
        type: 'signage',
        action: `Signpost the deciding detail for “${g.name}”`,
        title: `“${g.name}” usually needs a follow-up question`,
        observed: `Asked ${g.count} times; ${g.clarifications} needed a clarification before an answer could be given.`,
        why: 'One detail decides this item — usually material or condition — and it is not apparent at the bin.',
        next_step: `Consider Evans Hall station signage, or a line in the SOM sustainability FAQ, naming the deciding detail for ${g.name.toLowerCase()}.`,
      });
    }
  }

  for (const [key, hit] of themeHits) {
    if (hit.count < MIN_OBSERVATIONS) continue;
    const t = THEMES[key];
    out.push({
      kind: key,
      type: t.type,
      action: t.action,
      subject: t.subject,
      subject_label: t.subject_label,
      title: t.title,
      observed: `${hit.count} question${hit.count === 1 ? '' : 's'} in this period touched this; ${hit.unresolved} ended without a confirmed stream.`,
      why: t.why,
      next_step: t.next_step,
    });
  }

  // Answers marked unhelpful — about the answer, not about correctness.
  const ff = filters(range, cohort, { alias: 'q' });
  const unhelpful = db
    .prepare(`
      SELECT q.identified_item AS item, COUNT(*) AS n
      FROM feedback f JOIN queries q ON q.id = f.query_id ${ff.where} AND f.helpful = 0
      GROUP BY q.identified_item ORDER BY n DESC LIMIT 5
    `)
    .all(...ff.params);
  for (const u of unhelpful) {
    if (!u.item) continue;
    out.push({
      kind: 'unhelpful-feedback',
      type: 'answer-quality',
      action: `Review how WasteWise answers about “${u.item}”`,
      title: `“${u.item}” answers were marked unhelpful`,
      observed: `${u.n} response${u.n === 1 ? '' : 's'} about this item were marked unhelpful.`,
      why: 'Feedback records how the answer landed, not whether the sorting guidance was correct.',
      next_step: 'Read the comments in the Feedback section, then decide whether the wording or the underlying rule needs work.',
    });
  }

  return { ...base, limited_data: false, opportunities: out };
}
