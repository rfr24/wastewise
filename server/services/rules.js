import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES_PATH = fileURLToPath(new URL('../../data/rules.json', import.meta.url));

let kb = null;

export function loadRules() {
  if (!kb) kb = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
  return kb;
}

/**
 * Words that are real signal inside a phrase alias ("plastic bottle", "small
 * loose item") but worthless on their own. Letting "plastic" alone earn a loose
 * match attached the bottle and lid rules to a question about a plastic fork;
 * letting "item" earn one sent "partially eaten baked item" to the small-items
 * rule instead of the food rule.
 */
const GENERIC_MATERIAL = new Set([
  'plastic', 'paper', 'metal', 'glass', 'clear', 'small', 'large', 'disposable', 'single',
  'item', 'items', 'thing', 'things', 'object', 'piece', 'pieces', 'bit', 'bits',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'i', 'my', 'this', 'that', 'it',
  'in', 'on', 'to', 'of', 'for', 'with', 'where', 'what', 'which', 'can', 'put',
  'throw', 'go', 'goes', 'should', 'and', 'or', 'how', 'me', 'you', 'bin', 'at',
]);

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-phrase match. Plain substring matching is wrong here: the alias "can"
 * matched inside "cannot", which pulled the aluminum-can rule into completely
 * unrelated questions.
 */
function phraseInText(phrase, text) {
  return new RegExp(`(?<![a-z0-9])${escapeRe(phrase)}(?![a-z0-9])`, 'i').test(text);
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Score each rule against the query. Alias phrase matches dominate, so
 * "coffee cup" reliably outranks a rule that merely shares the word "cup".
 */
export function retrieveRules(query, limit = 4) {
  return retrieveScored(query, limit).map((s) => s.rule);
}

/** Retrieval with scores attached, so callers can judge how clear-cut a match is. */
export function retrieveScored(query, limit = 4) {
  const { rules } = loadRules();
  const lower = query.toLowerCase();
  const tokens = tokenize(query);

  const scored = rules.map((rule) => {
    let score = 0;
    let looseHits = 0;
    let namedExplicitly = false;
    // A "specific" hit means the query named this item, not merely its material.
    // "paper plate" must not count as a confident hit on the generic paper rule.
    let specific = false;
    for (const alias of rule.aliases) {
      const a = alias.toLowerCase();
      if (phraseInText(a, lower)) {
        if (GENERIC_MATERIAL.has(a)) {
          score += 2;
        } else {
          score += a.includes(' ') ? 14 : 6;
          namedExplicitly = true;
          specific = true;
        }
      } else if (
        tokens.some((t) => !GENERIC_MATERIAL.has(t) && a.split(' ').includes(t))
      ) {
        looseHits += 1;
      }
    }
    // Cap the loose single-word overlap: a rule with many aliases sharing one
    // generic word ("compostable") must not outrank an exact phrase hit
    // ("banana peel") on a more specific rule.
    score += Math.min(looseHits, 2) * 2;
    if (phraseInText(rule.item.toLowerCase(), lower)) {
      score += 8;
      namedExplicitly = true;
      specific = true;
    }
    for (const t of tokens) {
      if (!GENERIC_MATERIAL.has(t) && rule.item.toLowerCase().includes(t)) score += 1;
    }

    // A location-scoped rule (e.g. signage observed at one cafe) only applies when
    // the user actually names that location. Otherwise a generic question would be
    // dragged into a local conflict and lose its verified Yale-wide answer.
    if (rule.location_scope && !namedExplicitly) return { rule, score: 0, specific };

    // Material discriminators. Utensils are the motivating case: "fork" alone is
    // ambiguous and should surface every candidate so the assistant asks, but
    // once the material is known the wrong rules must drop out entirely rather
    // than trail along as irrelevant sources.
    if (rule.requires_any && !rule.requires_any.some((t) => phraseInText(t, lower))) {
      return { rule, score: 0, specific };
    }
    if (rule.disqualifiers?.some((t) => phraseInText(t, lower))) {
      return { rule, score: 0, specific };
    }
    return { rule, score, specific };
  });

  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length === 0) return [];

  // Keep only rules in the same league as the best match. A strong phrase hit
  // ("water bottle") should not drag along rules that merely share one weak token.
  // The floor of 2 keeps genuinely ambiguous cases ("fork") showing every
  // candidate, which is what makes the assistant ask instead of guess.
  const cutoff = Math.max(2, hits[0].score * 0.25);
  return hits.filter((s) => s.score >= cutoff).slice(0, limit);
}

/**
 * Location-scoped rules explicitly named in the user's caption.
 *
 * Captions like "I'm at Charley's Place" apply to the whole photo, so they must
 * not be appended to every item's retrieval query — that attached the cafe's
 * food-scraps signage to an unrelated ceramic plate. Instead the caller pulls
 * location rules once and attaches them only to items whose own rules share a
 * category.
 */
export function retrieveLocationRules(captionText = '') {
  if (!captionText.trim()) return [];
  return loadRules().rules.filter(
    (rule) => rule.location_scope && retrieveRules(captionText, 99).some((r) => r.id === rule.id),
  );
}

/** Context block injected into the prompt. Only retrieved rules are included. */
export function formatRulesForPrompt(rules) {
  if (rules.length === 0) return 'NO MATCHING RULES FOUND IN THE KNOWLEDGE BASE.';
  return rules
    .map(
      (r, _i, all) => {
        // Only announce a conflict when the contradicting rule is actually in play.
        // A rule's conflict metadata alone must not taint an unrelated question.
        const present = new Set(all.map((x) => x.id));
        const conflicts = [...(r.conflicts_with ?? []), ...(r.location_conflicts ?? [])].filter(
          (id) => present.has(id),
        );
        return `--- RULE ${r.id} ---
Item: ${r.item}
Recommended stream: ${r.stream ?? 'NONE — no stream determined'}
Verification status: ${r.verification_status}${
          conflicts.length
            ? `\nCONFLICT: this rule is contradicted by, or contradicts, rule(s): ${conflicts.join(', ')}. Surface the discrepancy; do not resolve it.`
            : ''
        }
Guidance: ${r.guidance}
Source: ${r.source.citation}`;
      },
    )
    .join('\n\n');
}

/**
 * Student-facing guide data.
 *
 * Deliberately does NOT include each rule's `guidance` field: that text is
 * written as instructions to the model ("DO NOT ask whether...") and must never
 * reach the UI. The UI gets `guide.tip` / `guide.detail` instead.
 */
export function quickReference() {
  const { rules, streams, meta } = loadRules();
  const withGuide = rules.filter((r) => r.guide);
  return {
    streams,
    resources: meta.resources ?? [],
    items: withGuide
      .filter((r) => r.guide.show)
      .map((r) => ({
        id: r.id,
        item: r.item,
        icon: r.guide.icon,
        destination: r.guide.destination,
        tip: r.guide.tip,
        detail: r.guide.detail,
        verification_status: r.verification_status,
        source: r.source,
      })),
    about: withGuide
      .filter((r) => !r.guide.show)
      .map((r) => ({
        id: r.id,
        icon: r.guide.icon,
        title: r.guide.about_title,
        body: r.guide.about_body,
        verification_status: r.verification_status,
        source: r.source,
      })),
  };
}
