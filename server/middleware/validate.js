export const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS ?? 500);

/**
 * Patterns that are almost always an attempt to steer the assistant rather than
 * ask about waste. Flagged (and logged), not silently trusted — the system prompt
 * is the real defense; this is cheap defense in depth and avoids paying for
 * obvious attacks.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  /disregard\s+(your|all|the)\s+(instructions|rules|system)/i,
  /(system|developer)\s*prompt/i,
  /you\s+are\s+now\s+(a|an)\s/i,
  /\bact\s+as\s+(a|an)\s/i,
  /reveal\s+(your|the)\s+(prompt|instructions|rules)/i,
  /<\s*\/?\s*(system|instructions)\s*>/i,
];

export function screenQuestion(text, { allowEmpty = false } = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return allowEmpty
      ? { ok: true, sanitized: '', suspicious: false }
      : { ok: false, error: 'Please enter a question.' };
  }
  if (trimmed.length > MAX_QUESTION_CHARS) {
    return { ok: false, error: `Please keep your question under ${MAX_QUESTION_CHARS} characters.` };
  }
  const suspicious = INJECTION_PATTERNS.some((p) => p.test(trimmed));
  // Strip control characters; the model sees the question wrapped in <question> tags.
  const sanitized = trimmed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return { ok: true, sanitized, suspicious };
}
