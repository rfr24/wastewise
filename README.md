# WasteWise — Know Before You Throw

A mobile-first waste-sorting assistant for Yale School of Management's Evans Hall.

Waste stations in Evans Hall are labeled inconsistently — some carry detailed signage,
some carry almost none. WasteWise lets a student ask "where does this go?" and get an
answer grounded in a curated rule set, with an explicit statement of how well confirmed
that answer is.

**The central design decision:** the assistant answers *only* from a curated knowledge
base (`data/rules.json`), not from the model's general knowledge. Every rule carries a
verification status, and the app refuses to present an unconfirmed rule as Yale policy.

## What it does today (MVP increment 4)

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

Not built yet: the operations dashboard UI, the final report.

## Quick start

```bash
npm install
cp .env.example .env     # then add your PORTKEY_API_KEY
npm start                # http://localhost:3000
```

If you are working inside the course folder, a `PORTKEY_API_KEY` in a parent
directory's `.env` is picked up automatically — `server/env.js` walks up from the
project root. Already-set environment variables always win.

Node 20.6+ required (the app uses the built-in `node:sqlite` module, so there is no
native build step). `npm run dev` starts it with file watching; `npm test` runs the suite.

The SQLite file is created automatically at `data/wastewise.db` on first run.

## Architecture

```
public/              Mobile-first frontend (no build step, plain HTML/CSS/JS)
server/
  index.js           Express app; serves the API and the static frontend
  routes/api.js      /ask, /guide, /feedback, /usage, /health
  services/
    rules.js         Keyword/alias retrieval over the knowledge base
    llm.js           Provider abstraction (Portkey / Anthropic), usage + cost
    vision.js        Photo pass — describes the item ONLY, never picks a stream
    parse.js         Tolerant JSON extraction shared by both passes
    assistant.js     Prompt, JSON parsing, verification and clarification guardrails
    db.js            SQLite (node:sqlite): query log + feedback + usage aggregates
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

## The knowledge base and verification statuses

`data/rules.json` is the source of truth. Each rule has one of three statuses:

| Status | Meaning | How the assistant may speak |
|---|---|---|
| `verified` | Confirmed against a cited authoritative source | May state as confirmed guidance |
| `observational` | Based on photographed Evans Hall signage or bin layout | Must present as an *observation* of what is posted — not a confirmed processing requirement |
| `unverified` | Drafted from general practice or an unconfirmed claim | Must express uncertainty; must not present as Yale guidance |

**Current status: 18 rules — 13 `verified`, 1 `observational`, 4 `unverified`.**

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

The two remaining `unverified` rules — `cup-lid-plastic` and
`utensils-conventional-plastic` — are items Yale has not published a rule for. The app
says so rather than guessing.

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
  **no published rate card for `gpt-6-luna`**, so `estimated_cost_usd` is `null` by default
  rather than an invented figure. Set `PRICE_INPUT_PER_MTOK` and `PRICE_OUTPUT_PER_MTOK`
  once the course publishes rates and the estimates appear. Read it all with `GET /api/usage`.

## Privacy

No account, no login, no session, no IP logging. Stored per question: the question text,
the identified item/category, the recommendation, confidence, and token counts — used for
the operations dashboard. IP addresses are used only in memory for rate limiting and are
never written to the database. **Uploaded photos are held in memory for the single API
call and are never written to disk or stored in the database** — only a `had_image` flag
is recorded.

## Scope limits

- WasteWise does **not** measure waste contamination or diversion rates. The dashboard
  measures *student questions and feedback* — what people are confused about.
- It does not state Yale or Evans Hall policy that is not in the knowledge base.
- There is no external compost drop-off map.
- It is a student project, not an official Yale service.

## Deployment

Any Node host works (Render, Railway, Fly.io). Set `PORTKEY_API_KEY` and the other
`.env.example` variables as environment variables, and run `npm start`. The SQLite file
lives on local disk, so attach a persistent volume if you need the dashboard data to
survive restarts.
