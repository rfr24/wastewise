import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * Admin authentication.
 *
 * One shared secret, held server-side only, exchanged for a signed session
 * cookie. The secret is never sent to the browser, never appears in an API
 * response, and is not stored in the database. If no secret is configured the
 * admin area stays switched off rather than falling open.
 */

const COOKIE = 'ww_admin';
const SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS ?? 8);

/**
 * Signing key for session cookies. A configured key keeps sessions valid across
 * restarts; without one a random key is generated, which is fine for local work
 * and simply means a restart logs you out.
 */
const signingKey =
  process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.length >= 16
    ? process.env.ADMIN_SESSION_SECRET
    : randomBytes(32).toString('hex');

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD);

/** Production must not run admin auth over plaintext HTTP. */
const isSecureRequest = (req) =>
  req.secure || req.headers['x-forwarded-proto'] === 'https';

const sign = (value) => createHmac('sha256', signingKey).update(value).digest('base64url');

/**
 * Compare without leaking length or content through timing. Both sides are
 * hashed first so the comparison is always over equal-length buffers.
 */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * A deployed instance must not accept an admin password over plaintext. Local
 * HTTP development is unaffected, because this only applies in production.
 */
export function requiresSecureTransport(req) {
  return process.env.NODE_ENV === 'production' && !isSecureRequest(req);
}

export function issueSession(res, req) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600_000 }),
  ).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  const parts = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  // Secure in production, and whenever the request already arrived over TLS, so
  // local HTTP development still works without weakening a deployed instance.
  if (process.env.NODE_ENV === 'production' || isSecureRequest(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function hasValidSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

export function passwordMatches(candidate) {
  if (!adminConfigured() || typeof candidate !== 'string' || !candidate) return false;
  return safeEqual(candidate, process.env.ADMIN_PASSWORD);
}

/* --- login throttling ----------------------------------------------------- */

const LOGIN_WINDOW_MS = Number(process.env.ADMIN_LOGIN_WINDOW_MS ?? 15 * 60_000);
const LOGIN_MAX = Number(process.env.ADMIN_LOGIN_MAX ?? 5);
const attempts = new Map();

export function loginThrottle(req, res, next) {
  const now = Date.now();
  const key = req.ip ?? 'unknown';
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait and try again.' });
  }
  recent.push(now);
  attempts.set(key, recent);
  if (attempts.size > 1000) attempts.clear();
  next();
}

export function clearLoginAttempts(req) {
  attempts.delete(req.ip ?? 'unknown');
}

export function _resetLoginThrottle() {
  attempts.clear();
}

/** Guards every admin endpoint, not only the dashboard page. */
export function requireAdmin(req, res, next) {
  if (!adminConfigured()) {
    return res.status(503).json({
      error: 'Admin access is not configured. Set ADMIN_PASSWORD in .env and restart.',
    });
  }
  if (!hasValidSession(req)) return res.status(401).json({ error: 'Sign in required.' });
  next();
}
