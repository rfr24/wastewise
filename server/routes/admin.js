import { Router } from 'express';
import {
  adminConfigured, requireAdmin, loginThrottle, passwordMatches,
  issueSession, clearSession, clearLoginAttempts, hasValidSession,
  requiresSecureTransport,
} from '../admin-auth.js';
import {
  overview, daily, insights, feedbackDetail, opportunities, cohortSummary,
  RANGES, DEFAULT_COHORT_FILTER,
} from '../services/analytics.js';
import { COHORT_FILTERS, COHORT_LABELS, defaultCohort, evalEnabled } from '../cohort.js';

const router = Router();

/** Only the three supported windows; anything else falls back to all time. */
const pickRange = (req) => (Object.hasOwn(RANGES, req.query.range) ? req.query.range : 'all');

/** Operational insights exclude development traffic unless asked otherwise. */
const pickCohort = (req) =>
  (Object.hasOwn(COHORT_FILTERS, req.query.cohort) ? req.query.cohort : DEFAULT_COHORT_FILTER);

router.post('/login', loginThrottle, (req, res) => {
  if (!adminConfigured()) {
    return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  }
  if (requiresSecureTransport(req)) {
    return res.status(403).json({ error: 'Admin sign-in requires HTTPS.' });
  }
  if (!passwordMatches(req.body?.password)) {
    // Deliberately identical for a wrong password and a missing one.
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  clearLoginAttempts(req);
  issueSession(res, req);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/** Lets the page decide what to show without revealing anything if signed out. */
router.get('/session', (req, res) =>
  res.json({ authenticated: hasValidSession(req), configured: adminConfigured() }));

// Everything below requires a valid session.
router.use(requireAdmin);

router.get('/overview', (req, res) => {
  const range = pickRange(req);
  const cohort = pickCohort(req);
  res.json({ ...overview(range, cohort), daily: daily(range, cohort) });
});
router.get('/insights', (req, res) => res.json(insights(pickRange(req), pickCohort(req))));
router.get('/feedback', (req, res) => res.json(feedbackDetail(pickRange(req), pickCohort(req))));
router.get('/opportunities', (req, res) =>
  res.json(opportunities(pickRange(req), pickCohort(req))));

/** What cohorts exist and how traffic is currently being labelled. */
router.get('/cohorts', (req, res) => res.json({
  labels: COHORT_LABELS,
  filters: Object.keys(COHORT_FILTERS),
  default_filter: DEFAULT_COHORT_FILTER,
  recording_as: defaultCohort(),
  evaluation_enabled: evalEnabled(),
  totals: cohortSummary(),
}));

export default router;
