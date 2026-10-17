/**
 * Provider abstraction for the WasteWise assistant.
 *
 * Default provider is Portkey (the course-provided gateway, OpenAI-compatible).
 * Anthropic is kept as an alternative so the project is not locked to one vendor.
 * Credentials are read from the environment only — never from the client.
 *
 * Portkey configuration is taken from the course's own working examples
 * (homeworks/01, homeworks/05): OpenAI-compatible SDK pointed at
 * https://api.portkey.ai/v1 with x-portkey-api-key and x-portkey-provider headers.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export const PROVIDER = process.env.LLM_PROVIDER ?? (process.env.PORTKEY_API_KEY ? 'portkey' : 'anthropic');

const PORTKEY_BASE_URL = process.env.PORTKEY_BASE_URL ?? 'https://api.portkey.ai/v1';
const PORTKEY_PROVIDER = process.env.PORTKEY_PROVIDER ?? 'openai';
const PORTKEY_MODEL = process.env.PORTKEY_MODEL ?? 'gpt-6-luna';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5';

export const MODEL = PROVIDER === 'portkey' ? PORTKEY_MODEL : ANTHROPIC_MODEL;

/**
 * Per-million-token rates, used only to estimate cost for the report. Read at call
 * time so the rates can be configured without a restart. No published rate card is
 * available for the course-provided models, so when the rates are unset this returns
 * null and the API reports estimated_cost_usd: null rather than inventing a number.
 * Token counts are always exact regardless.
 */
export function estimateCost(inputTokens, outputTokens, cachedInputTokens = null) {
  const inRate = process.env.PRICE_INPUT_PER_MTOK;
  const outRate = process.env.PRICE_OUTPUT_PER_MTOK;
  if (inRate === undefined || inRate === '' || outRate === undefined || outRate === '') return null;
  const cachedRate = process.env.PRICE_CACHED_INPUT_PER_MTOK;
  /*
   * Cached prompt tokens bill at a lower rate, so charging them at the full
   * input rate overstates cost — on this app's prompts the cached share of a
   * repeated call is almost the whole prompt. Only split the input when both a
   * cached rate and a measured cached count are available; otherwise fall back
   * to charging everything at the standard rate, which can overstate but never
   * understates.
   */
  const cached =
    cachedRate !== undefined && cachedRate !== '' && Number.isFinite(cachedInputTokens)
      ? Math.min(cachedInputTokens, inputTokens)
      : 0;
  const fresh = inputTokens - cached;
  return (
    (fresh / 1e6) * Number(inRate) +
    (cached / 1e6) * Number(cachedRate ?? 0) +
    (outputTokens / 1e6) * Number(outRate)
  );
}

let openaiClient = null;
let anthropicClient = null;

function portkey() {
  if (!openaiClient) {
    const key = process.env.PORTKEY_API_KEY;
    if (!key) throw new Error('PORTKEY_API_KEY is not set.');
    openaiClient = new OpenAI({
      apiKey: key,
      baseURL: PORTKEY_BASE_URL,
      defaultHeaders: { 'x-portkey-api-key': key, 'x-portkey-provider': PORTKEY_PROVIDER },
      // Measured upstream latency is highly variable (sub-second to >2 min).
      // A long timeout multiplied by retries made the worst case many minutes,
      // so fail sooner and retry once rather than leaving a student waiting.
      timeout: Number(process.env.LLM_TIMEOUT_MS ?? 60_000),
      maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 1),
    });
  }
  return openaiClient;
}

function anthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

/**
 * Send a system prompt plus one user turn (text, optionally with an image) and
 * return normalized text + usage, so callers don't care which provider ran.
 *
 * @param {{system: string, text: string, image?: {media_type: string, data: string}}} req
 * @returns {Promise<{text: string, model: string, input_tokens: number, output_tokens: number, estimated_cost_usd: number|null, refused: boolean}>}
 */
export async function complete({ system, text, image }) {
  return PROVIDER === 'portkey'
    ? completePortkey({ system, text, image })
    : completeAnthropic({ system, text, image });
}

async function completePortkey({ system, text, image }) {
  const content = [{ type: 'text', text }];
  if (image) {
    content.unshift({
      type: 'image_url',
      image_url: { url: `data:${image.media_type};base64,${image.data}` },
    });
  }

  const response = await portkey().chat.completions.create({
    model: PORTKEY_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: image ? content : text },
    ],
  });

  const usage = response.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  /*
   * The gateway reports how much of the prompt was served from its cache.
   * Verified against the live API: an identical repeated call returns
   * cached_tokens equal to the cache_write_tokens of the first call. Both are
   * recorded as reported — never inferred — so a run's cached share is measured
   * rather than estimated. Absent fields stay null rather than becoming 0.
   */
  const detail = usage.prompt_tokens_details ?? {};
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    text: response.choices?.[0]?.message?.content ?? '',
    model: response.model ?? PORTKEY_MODEL,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: num(detail.cached_tokens),
    cache_write_tokens: num(detail.cache_write_tokens),
    reasoning_tokens: num(usage.completion_tokens_details?.reasoning_tokens),
    estimated_cost_usd: estimateCost(inputTokens, outputTokens, num(detail.cached_tokens)),
    refused: response.choices?.[0]?.finish_reason === 'content_filter',
  };
}

async function completeAnthropic({ system, text, image }) {
  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  }
  content.push({ type: 'text', text });

  const response = await anthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 16000,
    output_config: { effort: process.env.ANTHROPIC_EFFORT ?? 'medium' },
    system,
    messages: [{ role: 'user', content }],
  });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    model: response.model ?? ANTHROPIC_MODEL,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimateCost(inputTokens, outputTokens),
    refused: response.stop_reason === 'refusal',
  };
}
