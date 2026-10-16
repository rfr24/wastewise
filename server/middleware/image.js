export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 5 * 1024 * 1024);

// Only formats we can sniff and the vision API accepts. HEIC is excluded: iOS
// converts to JPEG on upload through a file input, and we cannot verify it here.
const ALLOWED = new Map([
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/webp', (b) =>
    b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP'],
]);

/**
 * Validate an uploaded image supplied as a data URL or as {media_type, data}.
 * Checks the declared type against the actual magic bytes, so a renamed or
 * mislabeled file (e.g. a script claiming to be a JPEG) is rejected before it
 * ever reaches the API. Returns base64 ready to send; nothing is written to disk.
 */
export function validateImage(input) {
  if (!input) return { ok: false, error: 'No image supplied.' };

  let mediaType;
  let base64;

  if (typeof input === 'string') {
    const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(input.trim());
    if (!match) return { ok: false, error: 'Image must be a base64 data URL.' };
    [, mediaType, base64] = match;
  } else if (typeof input === 'object') {
    mediaType = input.media_type;
    base64 = input.data;
  }

  if (typeof mediaType !== 'string' || typeof base64 !== 'string' || !base64) {
    return { ok: false, error: 'Image must include a media type and base64 data.' };
  }
  mediaType = mediaType.toLowerCase();
  if (!ALLOWED.has(mediaType)) {
    return { ok: false, error: 'Please upload a JPEG, PNG, or WebP photo.' };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, error: 'Image data is not valid base64.' };
  }

  // Check the decoded size before allocating the whole buffer.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Photo is too large. Please keep it under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.` };
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, error: 'Image data could not be decoded.' };
  }
  if (buffer.length === 0) return { ok: false, error: 'Image data is empty.' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Photo is too large. Please keep it under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.` };
  }
  if (buffer.length < 16 || !ALLOWED.get(mediaType)(buffer)) {
    return { ok: false, error: 'That file does not look like a real JPEG, PNG, or WebP image.' };
  }

  return { ok: true, image: { media_type: mediaType, data: buffer.toString('base64') } };
}
