import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import api from './routes/api.js';
import admin from './routes/admin.js';
import { hasValidSession, adminConfigured } from './admin-auth.js';
import {
  evalCodeMatches, markEvaluationSession, clearEvaluationSession, evalEnabled,
} from './cohort.js';
import { PROVIDER, MODEL } from './services/llm.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '10mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api', api);
app.use('/api/admin', admin);

/*
 * The dashboard page itself is protected, not just its data endpoints: an
 * unauthenticated visitor gets the sign-in page and never the dashboard markup.
 * It is deliberately absent from the student-facing navigation.
 */
/*
 * Enrolment for a structured evaluation session. The organiser shares a link
 * carrying a short code; a matching code sets a signed cookie so that session's
 * questions are recorded as student evaluation rather than public usage. The
 * code is not an admin credential and grants no access to anything.
 */
app.get('/eval', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.clear !== undefined) {
    clearEvaluationSession(res);
    return res.redirect('/');
  }
  if (!evalEnabled()) return res.redirect('/');
  if (evalCodeMatches(req.query.code)) markEvaluationSession(res);
  // Either way the student lands on the normal assistant, with no hint about
  // whether the code was accepted.
  res.redirect('/');
});

app.get('/admin', (req, res) => {
  const page = adminConfigured() && hasValidSession(req) ? 'dashboard.html' : 'login.html';
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(join(PUBLIC_DIR, 'admin', page));
});

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Serve the shell with versioned asset URLs.
 *
 * app.js and styles.css were referenced by bare name, so a phone that had the
 * page open across a change could keep running the old script — the asset URL
 * never changed, and mobile Safari is happy to reuse a subresource it already
 * holds. Stamping a token derived from each file's size and mtime means any
 * edit produces a new URL, and the shell itself is never stored.
 */
function assetToken() {
  return ['app.js', 'styles.css']
    .map((f) => {
      const { size, mtimeMs } = statSync(join(PUBLIC_DIR, f));
      return `${size.toString(36)}${Math.round(mtimeMs).toString(36)}`;
    })
    .join('');
}

app.get(['/', '/index.html'], (req, res) => {
  const v = assetToken();
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${v}"`)
    .replace('src="app.js"', `src="app.js?v=${v}"`);
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(html);
});

app.use(express.static(PUBLIC_DIR));

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, next) => {
  console.error('[wastewise]', err.message);
  const status = err.statusCode ?? 500;
  const message =
    status === 500 ? 'WasteWise had trouble answering that. Please try again.' : err.message;
  res.status(status).json({ error: message });
});

// Only start listening when run directly, so tests can import the app and bind
// their own ephemeral port.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keyVar = PROVIDER === 'portkey' ? 'PORTKEY_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[keyVar]) {
    console.warn(`[wastewise] ${keyVar} is not set — /api/ask will fail. See .env.example.`);
  } else {
    console.log(`[wastewise] provider: ${PROVIDER} · model: ${MODEL}`);
  }
  // Loopback by default — binding to the LAN is opt-in, for phone testing only.
  const HOST = process.env.HOST ?? '127.0.0.1';
  app.listen(PORT, HOST, () => {
    console.log(`WasteWise running at http://localhost:${PORT}`);
    if (HOST === '0.0.0.0') {
      const nets = networkInterfaces();
      for (const addrs of Object.values(nets)) {
        for (const a of addrs ?? []) {
          if (a.family === 'IPv4' && !a.internal) {
            console.log(`  on this network:     http://${a.address}:${PORT}`);
          }
        }
      }
      console.log('  (LAN mode — anyone on this Wi-Fi can reach it. Stop the server when done.)');
    }
  });
}

export default app;
