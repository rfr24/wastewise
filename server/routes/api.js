import { Router } from 'express';
import { askAssistant } from '../services/assistant.js';
import { quickReference } from '../services/rules.js';
import {
  recordQuery, recordFeedback, queryExists, feedbackExists, usageSummary,
} from '../services/db.js';
import { rateLimit, dailyCap, feedbackRateLimit } from '../middleware/limits.js';
import { screenQuestion } from '../middleware/validate.js';
import { validateImage } from '../middleware/image.js';
import { buildId, diagnosticsEnabled, imageDimensions } from '../build.js';
import { cohortForRequest } from '../cohort.js';

const router = Router();

router.get('/health', (req, res) =>
  res.json({ ok: true, build: buildId(), diagnostics: diagnosticsEnabled() }));

router.get('/guide', (req, res) => res.json(quickReference()));

router.post('/ask', rateLimit, dailyCap, async (req, res, next) => {
  const hasImage = Boolean(req.body?.image);

  // With a photo the caption is optional; without one a question is required.
  const screened = screenQuestion(req.body?.question, { allowEmpty: hasImage });
  if (!screened.ok) return res.status(400).json({ error: screened.error });

  let image;
  if (hasImage) {
    const checked = validateImage(req.body.image);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    image = checked.image;
  }

  const tReq = performance.now();
  // Opt-in, local development only. Carries no image bytes and no question text.
  const diagnose = req.body?.diagnose === true && diagnosticsEnabled();
  const requestId = typeof req.body?.request_id === 'string'
    ? req.body.request_id.slice(0, 40).replace(/[^\w-]/g, '')
    : null;

  try {
    const { items, subject_unclear, usage, diagnostics } = await askAssistant({
      question: screened.sanitized,
      image,
      diagnose,
    });
    const primary = items[0] ?? {};
    const multi = items.length > 1;
    const tDb = performance.now();

    // We store the question text (for the operations dashboard) but no user
    // identifier, IP, or session — see README "Privacy".
    const queryId = recordQuery({
      question: screened.sanitized || '(photo only)',
      had_image: hasImage,
      identified_item: multi
        ? items.map((i) => i.identified_item).filter(Boolean).join(', ')
        : primary.identified_item ?? primary.identification?.label ?? null,
      category: multi ? 'multiple' : primary.category,
      recommendation: multi ? 'multiple' : primary.recommendation,
      confidence: multi ? 'multiple' : primary.confidence,
      needs_clarification: items.some((i) => i.needs_clarification),
      matched_rule_ids: [...new Set(items.flatMap((i) => (i.sources ?? []).map((r) => r.id)))],
      latency_ms: Math.round(performance.now() - tReq),
      // Server-decided. Never read from the request body, so a caller cannot
      // label their own traffic as evaluation or public usage.
      cohort: cohortForRequest(req),
      items,
      ...usage,
    });

    usage.timings_ms = {
      ...usage.timings_ms,
      db_ms: Math.round(performance.now() - tDb),
      server_total_ms: Math.round(performance.now() - tReq),
    };

    let trace;
    if (diagnose) {
      const bytes = image ? Buffer.from(image.data, 'base64') : null;
      trace = {
        request_id: requestId,
        build: buildId(),
        server_received: image
          ? {
              media_type: image.media_type,
              bytes: bytes.length,
              dimensions: imageDimensions(bytes),
            }
          : null,
        caption_chars: screened.sanitized.length,   // length only, never the text
        ...diagnostics,
        usage: {
          model: usage.model, input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens, fast_path: usage.fast_path === true,
          timings_ms: usage.timings_ms,
        },
      };
    }

    res.json({
      query_id: queryId,
      // One entry per distinct item. Photo identifications are echoed back so the
      // user can see what was read and correct it; the image itself is never
      // written to disk or stored in the database.
      items,
      subject_unclear,
      multi_item: multi,
      // Single-item responses also expose the primary item at the top level, so
      // existing single-item clients keep working unchanged.
      ...(multi ? {} : primary),
      flagged_input:
        screened.suspicious || items.some((i) => i.prompt_injection_detected === true),
      usage,
      ...(trace ? { trace } : {}),
    });
  } catch (err) {
    next(err);
  }
});

export const MAX_COMMENT_CHARS = Number(process.env.MAX_COMMENT_CHARS ?? 300);

router.post('/feedback', feedbackRateLimit, (req, res) => {
  const { query_id, helpful, comment } = req.body ?? {};
  if (!Number.isInteger(query_id) || !queryExists(query_id)) {
    return res.status(400).json({ error: 'Unknown query_id.' });
  }
  if (typeof helpful !== 'boolean') {
    return res.status(400).json({ error: 'helpful must be true or false.' });
  }

  let trimmed = null;
  if (comment !== undefined && comment !== null && comment !== '') {
    if (typeof comment !== 'string') {
      return res.status(400).json({ error: 'Comment must be text.' });
    }
    // Strip control characters, then enforce the length limit rather than
    // silently truncating what someone wrote.
    trimmed = comment.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (trimmed.length > MAX_COMMENT_CHARS) {
      return res
        .status(400)
        .json({ error: `Please keep your note under ${MAX_COMMENT_CHARS} characters.` });
    }
    if (!trimmed) trimmed = null;
  }

  // One response, one piece of feedback.
  if (feedbackExists(query_id)) {
    return res.status(409).json({ error: 'Feedback has already been recorded for this answer.' });
  }

  try {
    recordFeedback({ query_id, helpful, comment: trimmed });
  } catch (err) {
    console.error('[wastewise] feedback save failed:', err.message);
    return res.status(500).json({ error: 'Your feedback could not be saved. Please try again.' });
  }
  res.json({ ok: true, saved: true });
});

// Aggregate only — this powers the operations dashboard in a later increment
// and the cost section of the final report. Restricted to this machine, so that
// running in LAN mode for phone testing does not publish analytics to the Wi-Fi.
router.get('/usage', (req, res) => {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
  if (!local && process.env.ALLOW_REMOTE_USAGE !== '1') {
    return res.status(403).json({ error: 'Usage data is only available on the host machine.' });
  }
  res.json(usageSummary());
});

export default router;
