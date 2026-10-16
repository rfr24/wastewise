import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

/*
 * Traffic cohorts.
 *
 * Three kinds of traffic need telling apart without identifying anybody: the
 * author's own development testing, structured evaluation sessions with
 * recruited students, and organic public use. No IP address, device signal or
 * personal identifier is involved — a cohort is decided by server configuration
 * and, for evaluation sessions, by a short code the organiser hands out.
 */

export const COHORTS = ['development', 'student_eval', 'public'];
export const COHORT_LABELS = {
  development: 'Development',
  student_eval: 'Student evaluation',
  public: 'Public usage',
};

/** Filters the dashboard offers. "operational" is everything but development. */
export const COHORT_FILTERS = {
  operational: ['student_eval', 'public'],
  student_eval: ['student_eval'],
  public: ['public'],
  development: ['development'],
  all: COHORTS,
};

const COOKIE = 'ww_cohort';

/**
 * What a request counts as when nothing else applies. Local work is development
 * by default; a deployed instance records public usage. Never "student", since
 * a public visitor is not necessarily a student.
 */
export function defaultCohort() {
  const configured = process.env.DEFAULT_COHORT;
  if (configured && COHORTS.includes(configured)) return configured;
  return process.env.NODE_ENV === 'production' ? 'public' : 'development';
}

export const evalEnabled = () => Boolean(process.env.EVAL_ACCESS_CODE);

const signingKey =
  process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.length >= 16
    ? `${process.env.ADMIN_SESSION_SECRET}:cohort`
    : randomBytes(32).toString('hex');

const sign = (v) => createHmac('sha256', signingKey).update(v).digest('base64url');

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export const evalCodeMatches = (candidate) =>
  evalEnabled() && typeof candidate === 'string' && candidate.length > 0 &&
  safeEqual(candidate, process.env.EVAL_ACCESS_CODE);

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function markEvaluationSession(res) {
  const payload = 'student_eval';
  const parts = [
    `${COOKIE}=${payload}.${sign(payload)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=86400',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearEvaluationSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/**
 * The cohort for one request. Taken from a signed cookie issued against the
 * organiser's code, never from a request body or query parameter — a caller
 * cannot label their own traffic.
 */
export function cohortForRequest(req) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const dot = token.lastIndexOf('.');
    if (dot !== -1) {
      const payload = token.slice(0, dot);
      if (payload === 'student_eval' && safeEqual(token.slice(dot + 1), sign(payload))) {
        return 'student_eval';
      }
    }
  }
  return defaultCohort();
}
