const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX ?? 10);
const DAILY_CAP = Number(process.env.DAILY_REQUEST_CAP ?? 300);

// Feedback costs us nothing upstream, so it gets its own, roomier budget — a
// conversation now holds several answers, each with its own feedback control,
// and those must not eat the budget for asking questions.
const FEEDBACK_WINDOW_MS = Number(process.env.FEEDBACK_RATE_WINDOW_MS ?? 60_000);
const FEEDBACK_MAX = Number(process.env.FEEDBACK_RATE_MAX ?? 40);

const buckets = new Map();
const feedbackBuckets = new Map();
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

/** Per-IP sliding window. In-memory: fine for one process, swap for Redis if scaled out. */
export function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip ?? 'unknown';
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_REQUESTS) {
    return res.status(429).json({
      error: `Too many questions in a short time. Please wait about ${Math.ceil(WINDOW_MS / 1000)} seconds.`,
    });
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  next();
}

/** Hard ceiling on billable calls per day so a loop or a bot can't run up the API bill. */
export function dailyCap(req, res, next) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  if (dayCount >= DAILY_CAP) {
    return res.status(429).json({ error: 'WasteWise has hit its daily question limit. Please try again tomorrow.' });
  }
  dayCount += 1;
  next();
}

/** Separate budget for feedback, which makes no upstream API call. */
export function feedbackRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip ?? 'unknown';
  const hits = (feedbackBuckets.get(key) ?? []).filter((t) => now - t < FEEDBACK_WINDOW_MS);
  if (hits.length >= FEEDBACK_MAX) {
    return res.status(429).json({ error: 'Too much feedback at once. Please try again shortly.' });
  }
  hits.push(now);
  feedbackBuckets.set(key, hits);
  if (feedbackBuckets.size > 5000) feedbackBuckets.clear();
  next();
}

export function _resetLimits() {
  buckets.clear();
  feedbackBuckets.clear();
  dayCount = 0;
}
