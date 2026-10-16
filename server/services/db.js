import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH =
  process.env.DB_PATH ?? fileURLToPath(new URL('../../data/wastewise.db', import.meta.url));

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    question TEXT NOT NULL,
    had_image INTEGER NOT NULL DEFAULT 0,
    identified_item TEXT,
    category TEXT,
    recommendation TEXT,
    confidence TEXT,
    needs_clarification INTEGER DEFAULT 0,
    matched_rule_ids TEXT,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    query_id INTEGER NOT NULL,
    helpful INTEGER NOT NULL,
    comment TEXT,
    FOREIGN KEY (query_id) REFERENCES queries(id)
  );
`);

/*
 * Additive migrations. Existing rows are preserved; new columns are simply null
 * for anything recorded before they existed, and the dashboard labels them as
 * such rather than treating absence as zero.
 */
const columns = db.prepare("PRAGMA table_info('queries')").all().map((c) => c.name);
if (!columns.includes('latency_ms')) {
  db.exec('ALTER TABLE queries ADD COLUMN latency_ms INTEGER');
}
if (!columns.includes('cohort')) {
  // Everything recorded before cohorts existed was the author's own testing.
  db.exec("ALTER TABLE queries ADD COLUMN cohort TEXT NOT NULL DEFAULT 'development'");
  db.exec("UPDATE queries SET cohort = 'development' WHERE cohort IS NULL");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_queries_cohort ON queries(cohort)');

/*
 * One row per item in a multi-item photo. The parent `queries` row records
 * "multiple" for its recommendation, which loses the per-item destinations —
 * this table keeps them so the dashboard can break photos down by outcome.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS query_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    identified_item TEXT,
    category TEXT,
    recommendation TEXT,
    confidence TEXT,
    needs_clarification INTEGER DEFAULT 0,
    hazard_suspected INTEGER DEFAULT 0,
    observed_action INTEGER DEFAULT 0,
    rule_ids TEXT,
    FOREIGN KEY (query_id) REFERENCES queries(id)
  );
  CREATE INDEX IF NOT EXISTS idx_query_items_query ON query_items(query_id);
  CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
`);

export function recordQuery(row) {
  const stmt = db.prepare(`
    INSERT INTO queries (created_at, question, had_image, identified_item, category,
      recommendation, confidence, needs_clarification, matched_rule_ids, model,
      input_tokens, output_tokens, estimated_cost_usd, latency_ms, cohort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    new Date().toISOString(),
    row.question,
    row.had_image ? 1 : 0,
    row.identified_item ?? null,
    row.category ?? null,
    row.recommendation ?? null,
    row.confidence ?? null,
    row.needs_clarification ? 1 : 0,
    JSON.stringify(row.matched_rule_ids ?? []),
    row.model ?? null,
    row.input_tokens ?? 0,
    row.output_tokens ?? 0,
    row.estimated_cost_usd ?? null,
    Number.isFinite(row.latency_ms) ? Math.round(row.latency_ms) : null,
    row.cohort ?? 'development',
  );
  const queryId = Number(info.lastInsertRowid);

  // Per-item rows, so a photo of several things is not collapsed to "multiple".
  if (Array.isArray(row.items) && row.items.length > 0) {
    const child = db.prepare(`
      INSERT INTO query_items (query_id, position, identified_item, category, recommendation,
        confidence, needs_clarification, hazard_suspected, observed_action, rule_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    row.items.forEach((it, i) => {
      child.run(
        queryId, i + 1,
        it.identified_item ?? it.identification?.label ?? null,
        it.category ?? null,
        it.recommendation ?? null,
        it.confidence ?? null,
        it.needs_clarification ? 1 : 0,
        it.hazard_suspected ? 1 : 0,
        it.observed_action ? 1 : 0,
        JSON.stringify((it.sources ?? []).map((s) => s.id)),
      );
    });
  }
  return queryId;
}

export function recordFeedback({ query_id, helpful, comment }) {
  db.prepare(
    'INSERT INTO feedback (created_at, query_id, helpful, comment) VALUES (?, ?, ?, ?)',
  ).run(new Date().toISOString(), query_id, helpful ? 1 : 0, comment ?? null);
}

export function feedbackExists(queryId) {
  return !!db.prepare('SELECT 1 FROM feedback WHERE query_id = ?').get(queryId);
}

/**
 * Written feedback for the future operations dashboard. Anonymous by
 * construction: a feedback row links only to a query row, which itself holds no
 * user, session or IP information.
 */
export function recentComments(limit = 50) {
  return db
    .prepare(
      `SELECT f.created_at, f.helpful, f.comment, q.identified_item, q.category,
              q.recommendation, q.confidence
       FROM feedback f JOIN queries q ON q.id = f.query_id
       WHERE f.comment IS NOT NULL
       ORDER BY f.id DESC LIMIT ?`,
    )
    .all(limit);
}

export function queryExists(id) {
  return !!db.prepare('SELECT 1 FROM queries WHERE id = ?').get(id);
}

/** Aggregates for the (not-yet-built) dashboard and the cost section of the report. */
export function usageSummary() {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS queries, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              SUM(estimated_cost_usd) AS estimated_cost_usd,
              SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END) AS queries_without_rate
       FROM queries`,
    )
    .get();
  // Distinguish "no rate configured" from "cost was zero" — reporting $0 for
  // unpriced calls would understate spend in the final report.
  totals.estimated_cost_usd = totals.queries_without_rate > 0 && totals.estimated_cost_usd === null
    ? null
    : totals.estimated_cost_usd;
  const byCategory = db
    .prepare('SELECT category, COUNT(*) AS n FROM queries GROUP BY category ORDER BY n DESC')
    .all();
  const byConfidence = db
    .prepare('SELECT confidence, COUNT(*) AS n FROM queries GROUP BY confidence ORDER BY n DESC')
    .all();
  const clarifications = db
    .prepare('SELECT COALESCE(SUM(needs_clarification),0) AS asked FROM queries')
    .get();
  const feedback = db
    .prepare(
      `SELECT COALESCE(SUM(helpful),0) AS helpful,
              COUNT(*) - COALESCE(SUM(helpful),0) AS not_helpful,
              COUNT(comment) AS with_comment
       FROM feedback`,
    )
    .get();
  return { totals, byCategory, byConfidence, clarifications, feedback };
}

export default db;
