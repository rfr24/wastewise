# WasteWise — Know Before You Throw

A mobile-first waste-sorting assistant for Yale School of Management's Evans Hall.

Waste stations in Evans Hall are labeled inconsistently — some carry detailed signage,
some carry almost none. WasteWise lets a student ask "where does this go?" and get an
answer grounded in a curated rule set, with an explicit statement of how well confirmed
that answer is.

**The central design decision:** the assistant answers *only* from a curated knowledge
base (`data/rules.json`), not from the model's general knowledge. Every rule carries a
verification status, and the app refuses to present an unconfirmed rule as Yale policy.

## What it does today

- Text question → sorting recommendation, grounded in the rules knowledge base
- Confidence labeling: `confirmed` / `likely` / `uncertain`, enforced in code
- **Clarifying questions** when the right stream depends on a fact the user hasn't
  given (greasy vs. clean pizza box, resin number, battery type) — the app asks
  instead of guessing, and suppresses any bin recommendation until answered
- "Rules used" disclosure on every answer, with Yale citations and source links
- Quick-reference guide to the whole rule set
- Thumbs up/down feedback, stored for the operations dashboard
- **Photo identification, one answer per item** — upload or take a photo; a vision pass
  lists each distinct object, and every item is retrieved, guarded and answered separately
- **Conflict flagging** when photographed local signage contradicts Yale-wide guidance
- Exact token tracking on every API call, across both passes of a photo request
- **Operations dashboard** (`/admin`, password-protected) — question volume, confusion
  patterns, feedback, and consolidated signage opportunities, separated by traffic cohort

Both the student assistant and the operations dashboard are complete. The app has not
yet been deployed publicly and has not yet been tested with real students.

## Quick start

```bash
npm install
cp .env.example .env     # then add your PORTKEY_API_KEY
npm start                # http://localhost:3000
```

If you are working inside the course folder, a `PORTKEY_API_KEY` in a parent
directory's `.env` is picked up automatically — `server/env.js` checks the project root
first, then walks up to parent directories. Already-set environment variables always win.

### Running this from a fresh clone (teaching staff)

```bash
git clone https://github.com/rfr24/wastewise.git
cd wastewise
npm ci
npm start                # http://localhost:3000
```

`PORTKEY_API_KEY` is read from your `.env` one folder above the repo, so if the clone sits
inside your course folder there is nothing to configure — the student assistant works
immediately. `npm test` runs 329 offline tests and needs no key at all.

**To open the operations dashboard**, add one line to that same `.env` and restart:

```
ADMIN_PASSWORD=anything-you-like
```

Then visit <http://localhost:3000/admin> and sign in with that value. The password is
never stored and never leaves the server. Without it the dashboard stays switched off by
design rather than falling open, so this one line is the only extra step.

A fresh clone starts with an **empty** database, so the dashboard will show zeros until
you ask a few questions. That is expected: no development data ships with the repository.

**Node 24+ required** (declared in `package.json` as `engines.node`). The app uses the
built-in `node:sqlite` module, so there is no native build step and no compiler toolchain
on the host. `npm run dev` starts it with file watching; `npm test` runs the suite.

The SQLite file is created automatically at `data/wastewise.db` on first run; the
directory is created if it does not exist.

## Architecture

```
public/              Mobile-first student frontend (no build step, plain HTML/CSS/JS)
  admin/             Operations dashboard — sign-in page and the four-tab dashboard
server/
  index.js           Express app; serves the API, the frontend, /admin and /eval
  routes/api.js      /ask, /guide, /feedback, /usage, /health
  routes/admin.js    /login, /logout, /session, /overview, /insights, /feedback,
                     /opportunities, /cohorts — every one behind requireAdmin
  admin-auth.js      HMAC-signed session cookies, constant-time compare, login throttle
  cohort.js          Traffic cohorts; signed evaluation cookie, assigned server-side
  build.js           Build id for trace correlation; diagnostics gate; image header reads
  env.js             Loads .env from the project root, then walks up to parents
  services/
    rules.js         Keyword/alias retrieval over the knowledge base
    llm.js           Provider abstraction (Portkey / Anthropic), usage + cost
    vision.js        Photo pass — describes the item ONLY, never picks a stream
    parse.js         Tolerant JSON extraction shared by both passes
    assistant.js     Prompt, JSON parsing, verification and clarification guardrails
    db.js            SQLite (node:sqlite): schema, additive migrations, query log
    analytics.js     Every dashboard aggregate, with explicit coverage reporting
  middleware/
    limits.js        Per-IP rate limit + hard daily cap on billable calls
    validate.js      Length limits, control-char stripping, injection screening
    image.js         Format allowlist, size cap, magic-byte verification
data/rules.json      The knowledge base — rules, sources, verification statuses
```

**Request flow:** question → screen input → retrieve matching rules → build a prompt
containing *only* those rules → call the model → parse JSON → enforce verification and
clarification rules in code → log tokens/cost → return.

### Photo flow (two passes, many items)

A photo request runs **two** model calls regardless of how many items are in frame:

1. **Vision pass** (`server/services/vision.js`) — returns a structured *array* of the
   distinct objects it can see (max 8), each with material, condition, visible resin code
   or text, a reusable flag, and explicit uncertainty and occlusion flags. It is **never
   given the Yale rules** and its prompt forbids naming a bin. A test asserts that
   `vision.js` cannot even import the rules module.
2. **Reasoning pass** — one call covering every item. Each item gets its *own* rules
   retrieval and its *own* pass through `enforceVerification()`, so a scone and its
   wrapper get different answers and one ambiguous item never degrades a confident one.

A plate with leftover food and a fork is three answers: return the plate to the tray
return, the food's local stream is unverified, the fork depends on whether it is metal or
disposable. `alignItemResults()` tolerates a model that returns items out of order or
omits one — a missing entry degrades to `unknown` rather than inheriting a neighbour's bin.

**Captions are scoped by item count.** With one item in frame, the caption describes that
item ("this is an empty aluminum soda can") and feeds its retrieval. With several items it
describes the scene ("I'm at Charley's Place") and is deliberately kept *out* of per-item
retrieval; location rules it names are attached only to items whose own rules share a
category, so the cafe's food-scraps signage reaches the leftover food and not the plate.

So the vision model can identify a cup, but only the knowledge base can route it. If the
material or condition needed to pick a stream is uncertain, the assistant asks instead of
guessing — in testing, an ambiguous metal cylinder produced "Is the canister an aluminum
can?" rather than a confident recycling answer.

`identificationToQuery()` deliberately excludes the item's *condition* from the retrieval
query — "clean" describes state, not kind, and matching on it pulled unrelated rules into
the sources list. Condition still reaches the reasoning pass through the observation block.

**Upload safety** (`server/middleware/image.js`): JPEG/PNG/WebP only, 5 MB cap (configurable
via `MAX_IMAGE_BYTES`), and the declared media type is verified against the file's actual
magic bytes — a script renamed to `.jpg` is rejected. Photos are held in memory for the
single API call, are never written to disk, and are never stored in the database; only a
`had_image` flag is recorded.

**Vision support was tested, not assumed.** A one-off compatibility call sent a generated
red-circle PNG to `gpt-6-luna` through Portkey and got `{"shape":"circle","color":"red"}`
back, confirming image input works on the course model before any UI was built.

### Model provider

The default provider is **Portkey**, the course-provided gateway, running
**`gpt-6-luna`**. The configuration was taken from the course's own working examples
(`homeworks/01/read_card.py`, `homeworks/05/agents/model.py`), not guessed: an
OpenAI-compatible client pointed at `https://api.portkey.ai/v1` with `x-portkey-api-key`
and `x-portkey-provider` headers.

Anthropic is kept as an alternative provider behind the same interface — set
`LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Nothing outside `server/services/llm.js`
knows which provider ran. Keys are read from the environment server-side only.

One course note that does **not** affect WasteWise: `gpt-6-luna` rejects *function tools*
on `/v1/chat/completions` and needs `/v1/responses` for them. WasteWise uses no function
tools — it asks for a JSON object via `response_format` — so plain chat completions work,
and this is confirmed by live runs.

### API

| Endpoint | Purpose |
|---|---|
| `POST /api/ask` | `{question?, image?}` → recommendation, confidence, answer, caveats, sources, identification, usage. `image` is a base64 data URL; with a photo the question is optional |
| `GET /api/guide` | The full rule set for the quick-reference tab |
| `POST /api/feedback` | `{query_id, helpful, comment?}` |
| `GET /api/usage` | Aggregate counts, tokens, clarifications asked, and estimated cost |
| `GET /api/health` | Liveness check |

Admin endpoints live under `/api/admin` and every one is behind `requireAdmin`:

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/login` · `POST /api/admin/logout` · `GET /api/admin/session` | Session handling |
| `GET /api/admin/overview` | KPIs, daily volume, latency and token totals with coverage |
| `GET /api/admin/insights` | Confusion patterns, destinations, confidence, item grouping |
| `GET /api/admin/feedback` | Feedback detail |
| `GET /api/admin/opportunities` | Consolidated signage and education opportunities |
| `GET /api/admin/cohorts` | Available cohorts and their row counts |

All of them accept `range` (`7d` / `30d` / `all`) and `cohort` (see below).

## The knowledge base and verification statuses

`data/rules.json` is the source of truth. Each rule has one of three statuses:

| Status | Meaning | How the assistant may speak |
|---|---|---|
| `verified` | Confirmed against a cited authoritative source | May state as confirmed guidance |
| `observational` | Based on photographed Evans Hall signage or bin layout | Must present as an *observation* of what is posted — not a confirmed processing requirement |
| `unverified` | Drafted from general practice or an unconfirmed claim | Must express uncertainty; must not present as Yale guidance |

**Current status: 23 rules — 16 `verified`, 4 `observational`, 3 `unverified`.**

The verified rules cite published Yale pages that state the requirement directly:

| Source | Used for |
|---|---|
| [Single-Stream Recycling](https://recycling.yale.edu/recycling-on-campus/single-stream-recycling) | Accepted plastics (#1/#2/#5), paper, glass, metal; coffee cups and film plastics excluded; clean-and-empty requirement |
| [Recycling FAQ](https://recycling.yale.edu/frequently-asked-questions) | Greasy pizza boxes, compostable serviceware, small items, multi-material separation |
| [Food Waste](https://recycling.yale.edu/recycling-on-campus/food-waste) | Program scope, accepted materials, anaerobic digestion destination |
| [Electronic Recycling](https://recycling.yale.edu/recycling-on-campus/electronic-recycling) | E-waste as universal waste via EHS |
| [EHS Regulated Waste FAQs](https://ehs.yale.edu/regulated-waste-faqs) | Battery handling by type |
| [RecycleCT, "In the Bin"](https://www.recyclect.com/en/in-the-bin/) | Conventional plastic utensils (statewide WHAT'S OUT). Yale's own FAQ defers to RecycleCT for items it does not name |

A test asserts that every rule marked `verified` cites a real `*.yale.edu` URL, and that
no `unverified` rule asserts a stream — so the dataset cannot drift into unsourced claims.

### When sources disagree

A rule may carry `conflicts_with` / `location_conflicts`. The live example: Yale publishes
that compostable serviceware goes in the trash, while photographed signage at **Charley's
Place** in Evans Hall lists it as accepted. Both are recorded — the Yale-wide rule stays
`verified`, the signage is a separate `observational` rule — and when both are in play the
assistant surfaces the discrepancy and `enforceVerification()` blocks any `confirmed`
answer until Facilities verifies what is actually collected.

A second observation is recorded the same way: Charley's Place has a food-scraps and
compostables bin near the tray return whose posted sign includes leftover food. The
assistant tells students where it is and what the sign says, while stating that the
collection and processing behind it has not been independently verified. Answers that
touch Evans Hall food waste also carry a note that the SOM Sustainability Chairs are
working to confirm current guidelines — attached in code, so it appears verbatim and only
where relevant.

Both signage rules are `location_scope`d: they are only retrieved when the user names that
location. A generic "where does a compostable fork go?" still gets the confirmed Yale-wide
answer; asking about Charley's Place surfaces the conflict.

### Streams beyond the three bins

`return_dishware` covers reusable dining ware — ceramic plates and bowls, mugs, metal
cutlery — which is returned to the dish/tray return rather than binned. No published Yale
dish-return policy was found, so `reusable-dishware` is **observational**, based on the
photographed tray return at Charley's Place, and can never answer "confirmed". The rule
requires confirming the item is actually reusable and intact first: a disposable plate is a
different question, and broken ceramic is a cut hazard (Yale separately excludes "Plates,
ceramics" from single-stream recycling).

### Unidentified items and contamination

An item with **no matching rule** is never classified as confirmed trash. The assistant
asks what it is, and — only when the item is ordinary and clearly non-hazardous — adds
one sentence of general reasoning: trash is usually safer for an unidentified item,
because the wrong thing in recycling or food waste can contaminate a whole load. The
recommendation stays `unknown`, confidence stays `uncertain`, and a caveat records that
this is general reasoning rather than Yale guidance.

Hazard handling is enforced per item: a potentially hazardous item never receives a
station bin, **even when the model answers confidently**. If the model assigns one,
`enforceVerification()` overrides it to `special` (or `unknown`) and routes to Yale EHS.
`assessHazard()` blocks the safer-trash reasoning entirely for anything potentially hazardous —
batteries, electronics, chemicals, sharps, medication, bulbs, aerosols, unknown
substances — detected from the question text, the photo identification, or the category
of any retrieved rule. Those answers say the item must not go in any station bin and
route the student to Yale EHS. The check is deliberately over-inclusive: a false positive
just sends someone to EHS, while a false negative could put a lithium battery in a bin.

### No unsupported fallbacks

When the correct local stream is unverified, the assistant must not fall back to
suggesting a bin anyway. `stripUnsupportedFallback()` removes sentences that both hedge
("if there's no...", "otherwise") *and* direct ("put it in the trash"), then asks which
part of Evans Hall the user is in. Genuine explanations of Yale rules are left intact —
"Yale says compostable serviceware should go in the trash" survives, because it explains a
rule rather than offering a fallback.

**What stays unverified, and why.** Yale states its food waste program covers Yale College
dining halls and Yale Hospitality retail spaces, and that the university "currently does
not have capacity to offer compost service to non-dining spaces." Evans Hall is an
academic building, so it is *likely* not served — but Yale's page does not name Evans Hall,
so `evans-compost-availability` and `food-scraps` remain `unverified` pending confirmation
with SOM building operations. The app will not tell a student their scraps are composted.

Note that `compostable-serviceware` **is** verified, and verified to **trash**: Yale states
compostable utensils, plates and cups are neither recyclable nor accepted in food waste
bins. That is a restriction, not a claim that Evans Hall accepts compost.

The remaining `unverified` rule, `cup-lid-plastic`, is an item Yale has not published a
rule for. The app says so rather than guessing.

### Adding or promoting a rule

Edit `data/rules.json`, then run `npm test` — the suite checks that every rule has an id,
guidance, aliases, a citation, and a valid verification status. Restart the server to
pick up changes.

## Safety and cost controls

- **API key stays server-side.** The browser never sees it; `.env` is gitignored.
- **Image uploads:** format allowlist, size cap, and magic-byte verification; the vision
  prompt treats text visible *inside* a photo as data, not instructions, and flags it.
- **Prompt injection:** user text is wrapped in `<question>` tags and the system prompt
  designates it as data. Obvious injection patterns are flagged (`flagged_input` in the
  response, surfaced in the UI). The real defense is that the model has no Yale policy
  knowledge to leak — it can only answer from the retrieved rules.
- **Verification guardrail in code:** `enforceVerification()` re-checks the model's
  confidence against the actual statuses of the rules it cited and downgrades it if the
  model overstated. Tested directly.
- **Cost control:** per-IP sliding-window rate limit (10/min default) plus a hard daily
  cap on billable calls (`DAILY_REQUEST_CAP`, default 300). A 500-character limit on
  questions bounds input tokens.
- **Ask, don't guess:** `enforceVerification()` forces `recommendation: "unknown"` whenever
  the assistant asked a clarifying question or confidence is `uncertain`. A question can
  never ship alongside a bin.
- **Token/cost tracking:** every call logs exact input and output token counts. There is
  **cached** prompt tokens separately, as reported by the gateway. Cost is `null` until
  rates are configured, rather than an invented figure. Set `PRICE_INPUT_PER_MTOK`,
  `PRICE_CACHED_INPUT_PER_MTOK` and `PRICE_OUTPUT_PER_MTOK`
  once the course publishes rates and the estimates appear. Read it all with `GET /api/usage`.

## The operations dashboard

`/admin` is an admin-only view of what students are confused about. It is deliberately
absent from the student-facing navigation, and an unauthenticated visitor is served the
sign-in page rather than the dashboard markup. Four tabs: **Overview** (volume, unresolved
share, tokens, response time), **Sorting insights** (confusion patterns, where items were
directed, confidence), **Feedback**, and **Opportunities** (consolidated signage and
education actions, each with its supporting evidence).

**It counts questions, not students and not disposal actions.** There are no accounts, so
repeat questions cannot be attributed to a person, and nothing here measures whether
anyone actually sorted anything. Every figure that is only partially covered says so
rather than implying a confident total: 50 early multi-item photos predate per-item
records and are reported as a coverage gap, response times are only recorded from the
release that added them, and cost is `null` unless per-token rates are configured.

### Traffic cohorts

Analytics would be worthless if the author's own testing were mixed in with real student
use, so every row is tagged with one of three cohorts:

| Cohort | What it is |
|---|---|
| `development` | The author's own testing. All 88 existing local rows are this. |
| `student_eval` | A structured evaluation session with a recruited participant |
| `public` | Organic public use — the default once `NODE_ENV=production` |

A cohort is decided **server-side only** — from configuration, or for evaluation sessions
from an HMAC-signed cookie set by visiting `/eval?code=…` with the organiser's code. It is
never read from a request body or query parameter, so a caller cannot label their own
traffic. The evaluation code is **not** an admin credential and grants access to nothing.
The dashboard defaults to the **Operational** filter (everything except development).

## Security

- **Credentials never leave the server.** The browser receives no API key and no
  configuration; `.env` is gitignored and has never been committed.
- **Admin authentication:** one shared secret, exchanged for an HMAC-signed, `HttpOnly`,
  `SameSite=Lax` session cookie. The secret is never sent to the browser, never appears in
  an API response, and is not stored in the database. Comparisons are constant-time over
  SHA-256 digests. If `ADMIN_PASSWORD` is unset the admin area stays **switched off**
  rather than falling open.
- **Login throttling:** 5 attempts per IP per 15 minutes (configurable).
- **HTTPS required in production:** with `NODE_ENV=production`, an admin sign-in over
  plaintext HTTP is refused with 403. Session cookies carry `Secure` in production.
- **Reverse proxies:** one hop is trusted in production so per-IP limits see the real
  client address. Trusting more hops than actually sit in front would let a client spoof
  its address via `X-Forwarded-For` — override with `TRUST_PROXY` only if your host adds
  more.
- **Diagnostics cannot be switched on in production**, whatever the environment says.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `x-powered-by` off.

## Privacy

No accounts and no student login. IP addresses are held **in memory only**, for rate
limiting, and are never written to the database. Two cookies exist and neither identifies
anyone: the admin session cookie, and the evaluation-cohort cookie (which stores the
literal string `student_eval` and a signature, nothing else).

**Stored per question:** the question text, the identified item and category, the
recommendation, confidence, matched rule ids, token counts, response time, and cohort.
**Uploaded photos are held in memory for the single API call and are never written to
disk or stored in the database** — only a `had_image` flag is recorded.

Question text is free-form, so a student could in principle type something identifying
into it. Nothing prompts for personal information and no identifier is attached to a row,
but the text is stored verbatim for the confusion analysis the dashboard is built on.

## Testing

```bash
npm test          # 329 tests across 16 files, no network calls
```

The suite is offline and deterministic: no test calls the model API. Model behaviour is
exercised through recorded shapes and through the deterministic code paths — retrieval,
`enforceVerification()`, hazard handling, parsing, analytics aggregation, auth, cohort
assignment, and the rendered markup of both frontends.

Two tests depend on private photographs taken on a personal phone. Those files are not
published with the repository, and the tests **skip cleanly** when they are absent, so a
fresh clone reports 328 passing and 1 skipped with no failures.

The dataset is guarded by tests too: every rule needs an id, guidance, aliases, a citation
and a valid verification status; every `verified` rule must cite a real `*.yale.edu` URL;
and no `unverified` rule may assert a stream.

## Configuration

Every variable is documented with placeholder values in `.env.example`. Nothing here has
a secret default, and the app refuses to invent one.

| Variable | Purpose |
|---|---|
| `PORTKEY_API_KEY` | Course gateway credential. **Required.** |
| `PORTKEY_MODEL` · `PORTKEY_BASE_URL` · `PORTKEY_PROVIDER` | Gateway configuration |
| `LLM_PROVIDER` | `portkey` (default when a Portkey key is set) or `anthropic` |
| `ANTHROPIC_API_KEY` · `ANTHROPIC_MODEL` · `ANTHROPIC_EFFORT` | Alternative provider |
| `NODE_ENV` | `production` enables HTTPS enforcement, disables diagnostics, defaults the cohort to `public` |
| `PORT` · `HOST` | Listening port; host defaults to `0.0.0.0` in production, loopback locally |
| `TRUST_PROXY` | Reverse-proxy hops to trust. Defaults to 1 in production, 0 locally |
| `DB_PATH` | Where SQLite lives. Point at a persistent volume in production |
| `DEFAULT_COHORT` | Overrides the cohort new traffic is recorded as |
| `EVAL_ACCESS_CODE` | Enables `/eval?code=…` evaluation tagging. Not an admin credential |
| `ADMIN_PASSWORD` | **Required to enable `/admin`.** Unset means the dashboard is off |
| `ADMIN_SESSION_SECRET` | Keeps admin sessions valid across restarts (16+ chars) |
| `ADMIN_SESSION_HOURS` · `ADMIN_LOGIN_MAX` · `ADMIN_LOGIN_WINDOW_MS` | Session and throttle tuning |
| `RATE_LIMIT_WINDOW_MS` · `RATE_LIMIT_MAX` · `DAILY_REQUEST_CAP` | Abuse and cost protection |
| `MAX_QUESTION_CHARS` · `MAX_IMAGE_BYTES` · `LLM_TIMEOUT_MS` | Input bounds |
| `PRICE_INPUT_PER_MTOK` · `PRICE_CACHED_INPUT_PER_MTOK` · `PRICE_OUTPUT_PER_MTOK` | Optional cost estimation rates |
| `OPPORTUNITY_MIN_OBSERVATIONS` | Observations before a pattern becomes an opportunity |

### Database configuration

SQLite, via the built-in `node:sqlite` module. `DB_PATH` selects the file; its directory
is created if missing, and the schema is created on first run, so a brand-new file
initialises **empty and migrated** with no manual step. Migrations are additive only —
columns added later are `NULL` for older rows, and the dashboard labels them as uncovered
rather than treating absence as zero.

Development and production are separate files by configuration: local work uses
`./data/wastewise.db`, production points `DB_PATH` at a persistent volume
(e.g. `/var/data/wastewise.db`). **No development record is ever copied into production** —
a production database starts empty and fills only with real traffic. Every `.db` file is
gitignored, so neither database is ever published.

### Backup and recovery

SQLite is one file, so backup is a file copy — but a copy taken while the server is
writing can be torn. Use SQLite's own online backup, which is safe against a live writer:

```bash
sqlite3 /var/data/wastewise.db ".backup '/var/data/backups/wastewise-$(date +%F).db'"
```

Proposed approach, in order of what it protects against:

- **Scheduled copy.** A daily `.backup` into a dated file on the same volume, keeping the
  last 7 and a weekly for a month. Protects against a bad migration or accidental delete.
- **Off-volume copy.** The dated file pulled off the host periodically, so the data
  survives losing the volume itself. For a dataset this small, a manual download before
  and after each evaluation session is enough.
- **Before any schema change**, take a `.backup` first. Migrations here are additive and
  never drop data, but the cost of a copy is nothing against the cost of losing feedback.
- **Recovery** is a file swap: stop the app, move the dated file to `DB_PATH`, start it.
  Verify with a row count against the dashboard's own totals before trusting it.
- **Verify restores, not just backups.** A backup that has never been restored is a
  hypothesis. Restore one into a scratch `DB_PATH` and open the dashboard against it.

`backups/` and every `*.db` / `*.bak` / `*.dump` pattern are gitignored, so a backup can
never be committed.

## Known limitations

- **Not measured:** WasteWise does not measure contamination, diversion, or behaviour
  change. It measures questions asked and feedback given.
- **Evans Hall compost is unconfirmed.** Yale states it lacks capacity for non-dining
  spaces, and does not name Evans Hall either way, so the app will not tell a student
  their scraps are composted.
- **Signage observations are observations.** Four rules come from photographed Evans Hall
  signage and can never answer "confirmed".
- **Cost figures are list-price estimates, not invoices.** The app reaches the model
  through the course's Portkey gateway; published per-token list prices turn exact token
  counts into dollars, but nothing here observes an actual bill.
- **Partial analytics coverage** on response time and per-item photo outcomes, for rows
  predating those fields. The dashboard reports the coverage rather than hiding it.
- **Single process, in-memory limits.** Rate limits and the daily cap live in process
  memory, so they reset on restart and would need Redis if ever scaled beyond one instance.
- **SQLite is single-writer** and tied to one volume, which rules out multi-region hosting.
- **Model output varies between runs.** The deterministic guardrails constrain what can be
  said, not which phrasing comes back.
- **Not an official Yale service.** A student project.

## Scope limits

- WasteWise does **not** measure waste contamination or diversion rates. The dashboard
  measures *student questions and feedback* — what people are confused about.
- It does not state Yale or Evans Hall policy that is not in the knowledge base.
- There is no external compost drop-off map.
- It is a student project, not an official Yale service.

## Deployment

Node 24+, no build step, no native dependencies — `npm ci && npm start` is the whole
process. The requirements that matter:

1. **A persistent volume**, with `DB_PATH` pointing into it (e.g. `/var/data/wastewise.db`).
   Without one, every restart silently starts an empty database.
2. **HTTPS**, which admin sign-in requires in production. Both recommended hosts terminate
   TLS for you.
3. **`NODE_ENV=production`**, which enforces HTTPS for admin, disables diagnostics, marks
   cookies `Secure`, binds `0.0.0.0`, and records new traffic as `public`.
4. **Secrets as environment variables** — never in the repository. At minimum
   `PORTKEY_API_KEY` and `ADMIN_PASSWORD`; set `ADMIN_SESSION_SECRET` too, or every
   restart signs you out.
5. **One instance.** SQLite is single-writer and the rate limits are in-process.
