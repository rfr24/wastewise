const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------------------
   Destination vocabulary. One place defines the student-facing word, the icon
   and the colour class for every outcome, so results and the guide stay in step.
--------------------------------------------------------------------------- */
const DEST = {
  recycling:       { label: 'Recycle', likely: 'Likely recycling',           icon: 'i-recycle',  short: 'Recycle',
                     how: 'Put it in the mixed recycling bin.' },
  trash:           { label: 'Trash', likely: 'Likely trash',             icon: 'i-trash',    short: 'Trash',
                     how: 'Put it in the landfill bin.' },
  food_waste:      { label: 'Food scraps', likely: 'Likely food scraps',       icon: 'i-apple-core', short: 'Food scraps',
                     how: 'Put it in the food-scraps bin.' },
  return_dishware: { label: 'Return dishware', likely: 'Likely return dishware',   icon: 'i-dish',     short: 'Return',
                     how: 'Take it back to the dish / tray return.' },
  special:         { label: 'Special handling',  icon: 'i-alert',    short: 'Special',
                     how: 'Keep it out of every station bin.' },
  unknown:         { label: 'Let\u2019s narrow it down', icon: 'i-question', short: 'Depends', how: null },
  depends:         { label: 'Depends',           icon: 'i-question', short: 'Depends', how: null },
};

const STATUS_WORD = {
  verified: 'Backed by published Yale guidance',
  observational: 'Based on signage we photographed in Evans Hall',
  unverified: 'Not settled by any published source we could find',
};

// Development aid: switched on by the server, which only enables it outside
// production. The control is hidden entirely when the server says no.
let DIAGNOSTICS = false;
let SERVER_BUILD = null;
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => { DIAGNOSTICS = h.diagnostics === true; SERVER_BUILD = h.build ?? null; })
  .catch(() => {});

/** Metadata only: what this browser is, and what it made of the photo. */
function describeClient(trace) {
  const asset = document.querySelector('script[src*="app.js"]')?.getAttribute('src') ?? '';
  return {
    asset_url: asset,
    build_seen_by_page: /[?&]v=([a-z0-9]+)/.exec(asset)?.[1] ?? '(unversioned)',
    server_build: SERVER_BUILD,
    ua: navigator.userAgent.slice(0, 120),
    viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio ?? 1}`,
    photo: trace,
  };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* ---------------------------------------------------------------------------
   Tabs
--------------------------------------------------------------------------- */
function showPanel(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.panel === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('is-active', p.id === `panel-${name}`);
  });
  if (name === 'guide') loadGuide();
  if (name === 'about') loadGuide();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
});
$('#home-link').addEventListener('click', (e) => { e.preventDefault(); showPanel('ask'); });

/* ---------------------------------------------------------------------------
   Composer
--------------------------------------------------------------------------- */
const question = $('#question');
const counter = $('#counter');
const chat = $('#chat');

function autoGrow() {
  question.style.height = 'auto';
  question.style.height = `${Math.min(question.scrollHeight, 160)}px`;
}
question.addEventListener('input', () => {
  counter.textContent = `${question.value.length} / 500`;
  autoGrow();
});

// Enter sends; Shift+Enter inserts a newline. IME composition is left alone so
// the key that commits a character does not also submit the form.
question.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#ask-form').requestSubmit();
  }
});

$('#entry-ask').addEventListener('click', () => {
  question.focus();
  question.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
/**
 * On a phone, offer camera vs library explicitly: an input carrying `capture`
 * opens the camera but hides the photo library, so one control cannot do both.
 * On a desktop (fine pointer) `capture` is ignored anyway, so go straight to the
 * file picker and never show the chooser.
 */
// Treat anything without a fine pointer, or with a touch screen, as mobile —
// matchMedia alone can report oddly in in-app browsers.
const isTouchDevice = () =>
  (window.matchMedia?.('(pointer: coarse)').matches ?? false) ||
  navigator.maxTouchPoints > 0;

function openPhotoSource() {
  if (isTouchDevice()) {
    // Always open, never toggle: a second tap on "Snap a photo" should not
    // silently close the choices.
    const choice = $('#photo-choice');
    choice.hidden = false;
    choice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('#choose-camera').focus({ preventScroll: true });
  } else {
    // Desktop has no camera input worth offering — go straight to the picker.
    $('#photo-library').click();
  }
}
$('#entry-photo').addEventListener('click', openPhotoSource);
$('#photo-btn').addEventListener('click', openPhotoSource);
$('#choose-camera').addEventListener('click', () => {
  $('#photo-choice').hidden = true;
  $('#photo-camera').click();
});
$('#choose-library').addEventListener('click', () => {
  $('#photo-choice').hidden = true;
  $('#photo-library').click();
});

$('#examples').addEventListener('click', (e) => {
  if (!e.target.classList.contains('chip')) return;
  question.value = `Where does a ${e.target.textContent.toLowerCase()} go?`;
  counter.textContent = `${question.value.length} / 500`;
  autoGrow();
  $('#ask-form').requestSubmit();
});

/* ---------------------------------------------------------------------------
   Photo: preview is hidden entirely until a valid file is chosen.
--------------------------------------------------------------------------- */
let lastAsk = { question: '' };
// What the browser made of the chosen photo. Metadata only — never the bytes.
let photoTrace = null;
const newRequestId = () =>
  (crypto.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    .slice(0, 36);
let followUpInFlight = false;

let photoDataUrl = null;
const MAX_IMAGE_MB = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function clearPhoto() {
  photoDataUrl = null;
  photoTrace = null;
  question.placeholder = 'Ask WasteWise anything about sorting…';
  $('#photo-camera').value = '';
  $('#photo-library').value = '';
  $('#photo-choice').hidden = true;
  $('#photo-preview').hidden = true;
  $('#photo-thumb').removeAttribute('src');
  $('#photo-thumb').alt = '';
  $('#photo-name').textContent = '';
  $('#photo-size').textContent = '';
  $('#photo-btn').classList.remove('has-photo');
}

/**
 * Conversation lives in memory for this tab only — nothing is persisted, and the
 * uploaded photo is never kept in the transcript (a chip marks that one was sent).
 */
function newTurn(cls, html) {
  const el = document.createElement('div');
  el.className = `turn ${cls}`;
  el.innerHTML = html;
  chat.append(el);
  $('#chat-head').hidden = false;
  return el;
}

function scrollToTurn(el) {
  // 'nearest' keeps the page from lurching when the turn is already visible.
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showError(message) {
  scrollToTurn(newTurn('assistant', `<div class="error-card">${esc(message)}</div>`));
}

$('#clear-chat').addEventListener('click', () => {
  chat.innerHTML = '';
  $('#chat-head').hidden = true;
  lastAsk = { question: '' };
  question.focus();
});

/**
 * iPhones hand over HEIC unless the camera is set to "Most Compatible". Safari can
 * usually decode it, so try a canvas conversion to JPEG before giving up — and if
 * that fails, say plainly what to change rather than showing a format error.
 */
const MAX_EDGE = 1600;

/**
 * Normalise any chosen photo to a modest JPEG.
 *
 * Phone photos arrive at ~5712x4284 and 4-5 MB. That is far more than the vision
 * model needs, it is slow to upload over mobile data, and it sits right on the
 * 5 MB limit. Downscaling the long edge to 1600px keeps resin codes and labels
 * readable while cutting the upload substantially. HEIC is converted by the same
 * path, so there is one code path rather than two.
 */
async function toSupportedImage(file) {
  const needsConversion = !ALLOWED_TYPES.includes(file.type);
  const looksHeic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  photoTrace = {
    original: { type: file.type || '(none)', bytes: file.size,
                ext: (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase() },
    needs_conversion: needsConversion, looks_heic: looksHeic,
    bitmap: null, resized: false, converted: false, outcome: 'pending',
  };
  try {
    const bitmap = await createImageBitmap(file);
    photoTrace.bitmap = { width: bitmap.width, height: bitmap.height };
    if (!needsConversion && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE) {
      bitmap.close?.();
      photoTrace.outcome = 'sent-as-is';
      return file;                      // already small enough; leave it alone
    }
    const max = MAX_EDGE;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.9));
    if (!blob) throw new Error('conversion produced nothing');
    bitmap.close?.();
    photoTrace.resized = scale < 1;
    photoTrace.converted = true;
    photoTrace.output = { type: 'image/jpeg', bytes: blob.size,
                          width: canvas.width, height: canvas.height };
    photoTrace.outcome = 'converted';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (err) {
    // Conversion failed. If the original was already an accepted type we can
    // still send it as-is; only an unreadable format is a hard stop.
    if (photoTrace) {
      photoTrace.outcome = needsConversion ? 'failed' : 'fallback-original';
      photoTrace.error = String(err?.name ?? err ?? 'unknown');
    }
    if (!needsConversion) return file;
    throw new Error(
      looksHeic
        ? 'That photo is in Apple’s HEIC format and this browser can’t convert it. On your iPhone: Settings → Camera → Formats → Most Compatible, then take the photo again.'
        : 'Please choose a JPEG, PNG or WebP photo.',
    );
  }
}

async function handlePhotoFile(file) {
  if (!file) return clearPhoto();
  let usable;
  try {
    usable = await toSupportedImage(file);
  } catch (err) {
    clearPhoto();
    return showError(err.message);
  }
  if (usable.size > MAX_IMAGE_MB * 1024 * 1024) {
    clearPhoto();
    return showError(
      `That photo is ${(usable.size / 1024 / 1024).toFixed(1)} MB. Please keep it under ${MAX_IMAGE_MB} MB.`,
    );
  }

  const reader = new FileReader();
  // Reveal the preview only once the data URL exists, so a broken image
  // placeholder can never appear.
  reader.onload = () => {
    photoDataUrl = reader.result;
    const thumb = $('#photo-thumb');
    thumb.src = photoDataUrl;
    thumb.alt = `Preview of ${usable.name}`;
    $('#photo-name').textContent = usable.name;
    $('#photo-size').textContent = `${(usable.size / 1024).toFixed(0)} KB`;
    $('#photo-preview').hidden = false;
    $('#photo-btn').classList.add('has-photo');
    $('#photo-choice').hidden = true;
    // The caption guides which objects the photo is about, so say so.
    question.placeholder = 'Optional: tell me what to focus on';
  };
  reader.onerror = () => { clearPhoto(); showError('That photo could not be read. Try another one.'); };
  reader.readAsDataURL(usable);
}

for (const id of ['#photo-camera', '#photo-library']) {
  $(id).addEventListener('change', (e) => handlePhotoFile(e.target.files?.[0]));
}
$('#photo-remove').addEventListener('click', clearPhoto);

/* ---------------------------------------------------------------------------
   Submit
--------------------------------------------------------------------------- */
$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = question.value.trim();
  if (!text && !photoDataUrl) return;
  if ($('#submit').disabled) return;            // guards double submits

  const hadPhoto = Boolean(photoDataUrl);
  $('#submit').disabled = true;

  // The question joins the transcript immediately; the photo itself does not.
  scrollToTurn(newTurn('user', `
    ${hadPhoto ? '<span class="photo-chip">📷 Photo attached</span>' : ''}
    ${text ? `<p>${esc(text)}</p>` : '<p class="muted">Which bin does this go in?</p>'}`));

  const loading = newTurn('assistant', `<div class="loading">
      <div class="spinner"></div>
      <span class="loading-text">${hadPhoto ? 'Looking at your photo…' : 'Checking the rules…'}</span>
    </div>`);
  scrollToTurn(loading);
  const stopStages = runLoadingStages(hadPhoto, loading);

  const sentPhoto = photoDataUrl;
  question.value = '';
  counter.textContent = '0 / 500';
  autoGrow();
  clearPhoto();

  try {
    const requestId = newRequestId();
    const clientTrace = photoTrace;
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: text,
        ...(sentPhoto ? { image: sentPhoto } : {}),
        ...(DIAGNOSTICS ? { diagnose: true, request_id: requestId } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
    if (data.trace) data.trace.client = { request_id: requestId, ...describeClient(clientTrace) };
    lastAsk = { question: text || 'the item in my photo' };
    loading.remove();
    renderAnswer(data);
  } catch (err) {
    loading.remove();
    showError(err.message);
  } finally {
    stopStages();
    $('#submit').disabled = false;
  }
});

/**
 * Model latency here is genuinely unpredictable — measured anywhere from under a
 * second to over a minute — so the indicator names the stage it is on rather
 * than spinning silently. It does not editorialise about speed: photo work
 * taking ten seconds is normal, not an anomaly worth apologising for.
 */
function runLoadingStages(hasPhoto, host) {
  const stages = hasPhoto
    ? [[1200, 'Identifying what’s in the photo…'], [5000, 'Checking the Yale rules…'],
       [12000, 'Still working…']]
    : [[2500, 'Checking the Yale rules…'], [9000, 'Still working…']];
  const timers = stages.map(([ms, text]) =>
    setTimeout(() => {
      const el = host.querySelector('.loading-text');
      if (el) el.textContent = text;
    }, ms),
  );
  return () => timers.forEach(clearTimeout);
}

/* ---------------------------------------------------------------------------
   Results — action first.
   Order: what to do → one-line instruction → small caveat → expandable detail.
--------------------------------------------------------------------------- */
function renderAnswer(data) {
  const items = data.items?.length ? data.items : [data];
  const multi = items.length > 1;

  // When several items carry the same caveat — typically the Evans Hall
  // food-waste note — say it once above the cards instead of repeating the
  // whole paragraph on each one.
  const caveats = items.map((it) => buildCaveat(it, resolveAction(it)));
  const counts = new Map();
  const key = (c) => c && (c.title ?? c.body);
  caveats.forEach((c) => c && counts.set(key(c), (counts.get(key(c)) ?? 0) + 1));
  const sharedTitle = multi ? [...counts].find(([, n]) => n > 1)?.[0] : null;
  const shared = sharedTitle ? caveats.find((c) => key(c) === sharedTitle) : null;

  const turn = newTurn('assistant', `
    ${multi ? `<p class="found-head">I found ${items.length} items to sort.</p>` : ''}
    ${shared ? (shared.title
      ? `<div class="caveat shared">
          <div class="caveat-head">${icon('i-info')}<span>${esc(shared.title)}</span></div>
          <p>${esc(shared.body)}</p>
        </div>`
      : `<div class="caveat shared compact">${icon('i-info')}<span>${esc(shared.body)}</span></div>`) : ''}
    ${items.map((it, i) => renderResult(it, multi, caveats[i], sharedTitle)).join('')}
    ${data.flagged_input ? `<div class="caveat">
      <div class="caveat-head">${icon('i-alert')}<span>That looked like an instruction</span></div>
      <p>That message looked like it was trying to change WasteWise's instructions.
      WasteWise answered from its own rule set only.</p></div>` : ''}
    <div class="feedback">
      <div class="feedback-row">
        <span>Was this helpful?</span>
        <button type="button" class="fb-btn" data-helpful="true">Yes</button>
        <button type="button" class="fb-btn" data-helpful="false">No</button>
      </div>
      <form class="fb-form" hidden>
        <label class="fb-label">Anything we could improve? (optional)</label>
        <textarea class="fb-input" rows="2" maxlength="300"
          placeholder="e.g. I couldn't find the food-scraps bin."></textarea>
        <div class="fb-actions">
          <button type="submit" class="fb-send">Send feedback</button>
          <span class="fb-count">0 / 300</span>
        </div>
      </form>
    </div>`);

  wireReplies(turn);
  wireFeedback(turn, data);
  if (data.trace) attachDiagnostics(turn, data, items);
  scrollToTurn(turn);
}

/**
 * Adds a "Copy diagnostics" control under an answer. The payload includes the
 * headline actually rendered, which is the thing screenshots disagree about.
 * Clipboard access needs a secure context, so plain HTTP falls back to a
 * selectable box the student can copy by hand.
 */
function attachDiagnostics(turn, data, items) {
  const payload = {
    ...data.trace,
    rendered: items.map((it) => ({
      item: it.identification?.label ?? it.identified_item ?? null,
      headline: turnHeadline(it),
      recommendation: it.recommendation,
      confidence: it.confidence,
      clarification_optional: it.clarification_optional === true,
      has_question: Boolean(it.clarifying_question),
    })),
  };
  const text = JSON.stringify(payload, null, 2);

  const box = document.createElement('div');
  box.className = 'diag';
  box.innerHTML = `
    <button type="button" class="diag-btn">Copy diagnostics</button>
    <span class="diag-build">build ${esc(payload.build ?? '?')} · ${esc(payload.request_id ?? '?')}</span>
    <textarea class="diag-text" readonly hidden>${esc(text)}</textarea>`;
  turn.append(box);

  box.querySelector('.diag-btn').addEventListener('click', async () => {
    const btn = box.querySelector('.diag-btn');
    const area = box.querySelector('.diag-text');
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
    } catch {
      // http:// is not a secure context on a phone, so show it to copy by hand.
      area.hidden = false;
      area.focus();
      area.setSelectionRange(0, text.length);
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      btn.textContent = copied ? 'Copied ✓' : 'Select all above, then Copy';
    }
  });
}

/** The headline this item renders as — mirrors renderResult. */
function turnHeadline(item) {
  const act = resolveAction(item);
  const meta = DEST[act.dest] ?? DEST.unknown;
  const base = act.label
    ?? (item.confidence === 'likely' && meta.likely && !act.provisional ? meta.likely : meta.label);
  return act.where ? `${base} — ${act.place ?? ''}`.replace(/ — $/, '') : base;
}

/**
 * Decide what the card leads with.
 *
 * A real recommendation leads. Failing that, an observed action (e.g. the
 * photographed food-scraps bin) leads but is marked as observed and caveated.
 * Failing that, the card leads with the clarifying question. An unknown result
 * is never dressed up as a confirmed one.
 */
function resolveAction(item) {
  if (item.recommendation && item.recommendation !== 'unknown') {
    return { dest: item.recommendation, provisional: false, where: null };
  }
  // Possibly hazardous but not yet pinned down: "keep it out of every bin" is
  // itself the guidance, so it leads loudly rather than as a neutral "depends".
  if (item.hazard_suspected) {
    return {
      dest: 'special', observed: false,
      label: 'DON’T BIN IT',
      where: 'Check with Yale EHS before disposing of this',
    };
  }
  if (item.observed_action) {
    const a = item.observed_action;
    return {
      dest: a.destination,
      // Provisional: a real, usable action that rests on observed signage only.
      provisional: true,
      where: a.where,
      place: a.place ?? null,
      instruction: a.instruction ?? null,
      caveatBody: a.caveat ?? null,
      label: DEST[a.destination]?.label ?? a.label,
    };
  }
  return { dest: 'unknown', provisional: false, where: null };
}

function renderResult(item, multi, caveat, sharedTitle) {
  const act = resolveAction(item);
  const meta = DEST[act.dest] ?? DEST.unknown;
  const name = item.identification?.label ?? item.identified_item ?? null;
  // A caveat shown once above the cards is reduced to its heading here, so the
  // uncertainty stays visible on every card without repeating the paragraph.
  const isShared = Boolean(caveat && sharedTitle && (caveat.title ?? caveat.body) === sharedTitle);

  // Headline reads as one phrase — "Food scraps — Charley's Place" — rather
  // than a shouted stream name with the location bolted underneath. A merely
  // likely answer says so, instead of being demoted to "let's narrow it down".
  // "Likely trash" for a provisional identification — but not on an observed
  // action, whose own note already says the collection is unconfirmed.
  const base = act.label
    ?? (item.confidence === 'likely' && meta.likely && !act.provisional
      ? meta.likely
      : meta.label);
  const headline = act.where ? `${base} — ${act.place ?? ''}`.replace(/ — $/, '') : base;

  return `
  <div class="result-card d-${esc(act.dest)}${act.provisional ? ' is-provisional' : ''}">
    <div class="action">
      <span class="action-icon">${icon(meta.icon)}</span>
      <span class="action-text">
        ${name ? `<span class="eyebrow">${esc(name)}</span>` : ''}
        <span class="action-label">${esc(headline)}</span>
        ${act.instruction || item.answer
          ? `<span class="instruction">${esc(act.instruction ?? item.answer)}</span>`
          : ''}
      </span>
    </div>

    ${caveat ? (caveat.title
      ? `<div class="caveat${isShared ? ' terse' : ''}">
          <div class="caveat-head">${icon('i-info')}<span>${esc(caveat.title)}</span></div>
          ${isShared ? '' : `<p>${esc(caveat.body)}</p>`}
        </div>`
      : `<div class="caveat compact">${icon('i-info')}<span>${esc(caveat.body)}</span></div>`) : ''}

    ${item.clarifying_question ? `<div class="askblock${item.clarification_optional ? ' optional' : ''}">
        <div class="askblock-head">${icon('i-question')}<span>${
          item.clarification_optional ? 'Not sure?' : 'One quick question'
        }</span></div>
        <p>${esc(item.clarifying_question)}</p>
        ${item.clarification_optional ? '<span class="optional-chip">Optional clarification</span>' : ''}
        <button type="button" class="askblock-btn">Answer this</button>
        <form class="reply" hidden
              data-q="${esc(item.clarifying_question)}"
              data-item="${esc(name ?? '')}">
          <textarea class="reply-input" rows="1" maxlength="300"
            placeholder="Type your answer…" aria-label="Your answer"></textarea>
          <button type="submit" class="reply-send">Send</button>
        </form>
      </div>` : ''}

    ${renderFoot(item, act.instruction ?? item.answer)}
  </div>`;
}

/**
 * The small caveat under the action. Always carries a plain-language heading so
 * a provisional answer announces itself, and folds in the Sustainability Chairs'
 * note where it is relevant rather than adding a second block.
 */
function buildCaveat(item, act) {
  const som = item.sustainability_note
    ? ' SOM Sustainability Chairs are confirming current collection arrangements.'
    : '';

  if (act.provisional) {
    // Compact single line — the full explanation lives under More details.
    return {
      title: null,
      body: act.caveatBody ?? 'Based on posted signage; collection details are still being verified.',
    };
  }
  if (item.hazard_suspected) {
    return {
      title: 'Needs special handling',
      body: 'Keep this out of every station bin. Yale EHS can tell you how to dispose of it safely — 203-432-6545.',
    };
  }
  const first = (item.caveats ?? []).filter(Boolean)[0];
  if (item.confidence === 'uncertain' && first) {
    return { title: 'Not settled yet', body: first + som };
  }
  if (item.confidence === 'likely' && first) {
    return { title: 'Based on what we have observed', body: first + som };
  }
  if (som) return { title: 'Being confirmed', body: som.trim() };
  return null;
}

/** Footer row: where it came from on the left, the details toggle on the right. */
function renderFoot(item, shown) {
  const sources = item.sources ?? [];
  const caveats = (item.caveats ?? []).filter(Boolean);
  // When the card leads with a fixed one-liner, the assistant's own fuller
  // explanation still belongs somewhere — here, rather than nowhere.
  const fuller = item.answer && item.answer !== shown ? item.answer : null;
  if (!sources.length && !caveats.length && !fuller) return '';

  const statuses = new Set(sources.map((s) => s.verification_status));
  const origin = statuses.has('verified')
    ? 'Source: Yale guidance'
    : statuses.has('observational')
      ? 'Source: Evans Hall signage'
      : 'Source: no published rule found';

  return `
  <details class="more">
    <summary><span class="foot-src">${esc(origin)}</span><span class="foot-more">More details</span></summary>
    <div class="more-body">
      ${statuses.size ? `<div class="status-row">${[...statuses]
        .map((st) => `<span class="status ${esc(st)}">${esc(STATUS_WORD[st] ?? st)}</span>`)
        .join('')}</div>` : ''}
      ${fuller ? `<h4>The longer answer</h4><p>${esc(fuller)}</p>` : ''}
      ${caveats.length ? `<h4>Worth knowing</h4><ul>${caveats
        .map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      ${sources.length ? `<h4>Rules used</h4>${sources.map((s) => `
        <p><strong>${esc(s.item)}</strong><br />
        ${esc(s.source?.citation ?? 'No citation on file.')}
        ${s.source?.url ? `<br /><a class="src-link" href="${esc(s.source.url)}"
          target="_blank" rel="noopener noreferrer">View the source →</a>` : ''}</p>`).join('')}` : ''}
    </div>
  </details>`;
}

/**
 * Clarifying questions answer in place. The student types only their answer; the
 * original question and the item are carried along behind the scenes, so the
 * main composer is never stuffed with the assistant's own words.
 */
function wireReplies(turn) {
  turn.querySelectorAll('.askblock').forEach((block) => {
    const btn = block.querySelector('.askblock-btn');
    const form = block.querySelector('.reply');
    if (!btn || !form) return;
    const input = form.querySelector('.reply-input');

    btn.addEventListener('click', () => {
      btn.hidden = true;
      form.hidden = false;
      input.focus();
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendFollowUp(form);
    });
  });
}

async function sendFollowUp(form) {
  const input = form.querySelector('.reply-input');
  const send = form.querySelector('.reply-send');
  const reply = input.value.trim();
  if (!reply || followUpInFlight) return;

  followUpInFlight = true;
  input.disabled = true;
  send.disabled = true;
  send.textContent = 'Sending…';
  scrollToTurn(newTurn('user', `<p>${esc(reply)}</p>`));
  const loading = newTurn('assistant', `<div class="loading">
      <div class="spinner"></div><span class="loading-text">Checking the rules…</span>
    </div>`);
  scrollToTurn(loading);

  // Rebuild the full picture for the model: what was originally asked, which
  // item it was about, the question it asked, and the student's answer.
  const subject = form.dataset.item || lastAsk.question || 'the item';
  const composed = `${lastAsk.question || subject}. Answering "${form.dataset.q}": ${reply}`;

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: composed.slice(0, 500) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
    lastAsk = { question: composed.slice(0, 500) };
    loading.remove();
    // The question has been answered — retire the field rather than leaving a
    // second copy of it in the transcript.
    form.remove();
    renderAnswer(data);
  } catch (err) {
    loading.remove();
    send.disabled = false;
    input.disabled = false;
    send.textContent = 'Send';
    const note = document.createElement('p');
    note.className = 'reply-error';
    note.textContent = err.message;
    form.after(note);
  } finally {
    followUpInFlight = false;
  }
}

/**
 * Yes/No first, then an optional note. The confirmation only appears once the
 * server has actually persisted the row — the previous version congratulated the
 * student immediately and swallowed failures.
 */
function wireFeedback(turn, data) {
  const box = turn.querySelector('.feedback');
  if (!box) return;
  const form = box.querySelector('.fb-form');
  const input = box.querySelector('.fb-input');
  const count = box.querySelector('.fb-count');
  let helpful = null;
  let sending = false;

  box.querySelectorAll('.fb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      helpful = btn.dataset.helpful === 'true';
      box.querySelectorAll('.fb-btn').forEach((b) => b.classList.toggle('is-on', b === btn));
      form.hidden = false;
      input.focus();
    });
  });

  input?.addEventListener('input', () => {
    count.textContent = `${input.value.length} / 300`;
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (helpful === null || sending) return;
    sending = true;
    const send = form.querySelector('.fb-send');
    send.disabled = true;
    send.textContent = 'Saving…';
    box.querySelector('.fb-error')?.remove();

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query_id: data.query_id,
          helpful,
          comment: input.value.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Your feedback could not be saved.');
      box.innerHTML = '<span class="done">Thanks! Your anonymous feedback has been saved.</span>';
    } catch (err) {
      sending = false;
      send.disabled = false;
      send.textContent = 'Send feedback';
      const note = document.createElement('p');
      note.className = 'fb-error';
      note.textContent = err.message;
      form.append(note);
    }
  });
}

/* ---------------------------------------------------------------------------
   Quick guide
--------------------------------------------------------------------------- */
let guideData = null;
let activeFilter = 'all';
let guidePromise = null;

const FILTERS = [
  ['all', 'All', 'i-sparkle'],
  // Unicode U+267B followed by U+FE0E, the text variation selector: the
  // conventional symbol every browser ships, but in its monochrome form so it
  // takes the same grey as the drawn icons instead of rendering as a colour emoji.
  ['recycling', 'Recycle', '♻\uFE0E'],
  ['trash', 'Trash', 'i-trash'],
  ['food_waste', 'Food scraps', 'i-apple-core'],
  ['return_dishware', 'Return', 'i-dish'],
  ['special', 'Special', 'i-alert'],
  ['depends', 'Depends', 'i-question'],
];

function loadGuide() {
  if (guidePromise) return guidePromise;
  guidePromise = fetch('/api/guide')
    .then((r) => r.json())
    .then((data) => {
      guideData = data;
      $('#guide-filters').innerHTML = FILTERS.map(
        ([key, label, ic]) =>
          `<button type="button" class="filter f-${key}${key === 'all' ? ' is-on' : ''}"
             data-filter="${key}" aria-pressed="${key === 'all'}">
             ${ic.startsWith('i-')
               ? icon(ic)
               : `<span class="filter-emoji" aria-hidden="true">${ic}</span>`}
             <span>${label}</span>
           </button>`,
      ).join('');
      $('#guide-filters').addEventListener('click', (e) => {
        const btn = e.target.closest('.filter');
        if (btn) setFilter(btn.dataset.filter);
      });
      renderAbout(data);
      renderGuide();
    })
    .catch(() => {
      $('#guide-list').innerHTML = '<div class="error-card">Could not load the quick guide.</div>';
    });
  return guidePromise;
}

function setFilter(key) {
  activeFilter = key;
  document.querySelectorAll('.filter').forEach((f) => {
    const on = f.dataset.filter === key;
    f.classList.toggle('is-on', on);
    f.setAttribute('aria-pressed', String(on));
  });
  renderGuide();
}

$('#guide-search').addEventListener('input', renderGuide);

function renderGuide() {
  if (!guideData) return;
  const term = $('#guide-search').value.trim().toLowerCase();
  const matches = guideData.items.filter((i) => {
    const okFilter = activeFilter === 'all' || i.destination === activeFilter;
    const okTerm =
      !term ||
      i.item.toLowerCase().includes(term) ||
      i.tip.toLowerCase().includes(term) ||
      i.detail.toLowerCase().includes(term);
    return okFilter && okTerm;
  });

  $('#guide-empty').hidden = matches.length > 0;
  $('#guide-list').innerHTML = matches
    .map((i) => {
      const d = DEST[i.destination] ?? DEST.depends;
      const provisional = i.verification_status !== 'verified';
      return `
      <details class="guide-item">
        <summary>
          <span class="guide-emoji" aria-hidden="true">${esc(i.icon)}</span>
          <span class="guide-main">
            <span class="guide-name">${esc(i.item)}</span>
            <span class="guide-tip">${esc(i.tip)}</span>
          </span>
          <span class="guide-dest dest-${esc(i.destination)}">${esc(d.short)}</span>
          ${icon('i-chevron', 'guide-chev')}
        </summary>
        <div class="guide-detail">
          <p>${esc(i.detail)}</p>
          ${provisional ? `<p class="guide-status">${esc(STATUS_WORD[i.verification_status] ?? '')}.</p>` : ''}
          ${i.source?.url ? `<a class="src-link" href="${esc(i.source.url)}"
            target="_blank" rel="noopener noreferrer">View the source →</a>` : ''}
        </div>
      </details>`;
    })
    .join('');
}

function renderAbout(data) {
  // Each observation is individually expandable, so the section is scannable on
  // a phone instead of a wall of text.
  $('#about-list').innerHTML = (data.about ?? [])
    .map(
      (a) => `<details class="about-item">
        <summary>
          <span class="about-emoji" aria-hidden="true">${esc(a.icon)}</span>
          <span class="about-title">${esc(a.title)}</span>
          ${icon('i-chevron', 'acc-chev')}
        </summary>
        <div class="about-item-body">
          <p>${esc(a.body)}</p>
          <span class="status ${esc(a.verification_status)}">${esc(STATUS_WORD[a.verification_status] ?? a.verification_status)}</span>
        </div>
      </details>`,
    )
    .join('');
  $('#about-resources').innerHTML = (data.resources ?? [])
    .map(
      (r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)} →</a></li>`,
    )
    .join('');
}
