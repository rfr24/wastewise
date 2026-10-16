import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A short identifier for the code currently being served, so a trace from a
 * phone can be matched against a trace from a laptop. Derived from the files
 * that actually change behaviour — if the phone reports a different build id,
 * it is running different code.
 */
export function buildId() {
  const files = [
    'public/app.js', 'public/index.html', 'public/styles.css',
    'server/services/assistant.js', 'server/services/vision.js', 'data/rules.json',
  ];
  let acc = 0;
  for (const f of files) {
    const { size, mtimeMs } = statSync(join(ROOT, f));
    // Cheap, order-sensitive mix; collisions do not matter for a dev marker.
    acc = (acc * 31 + size + Math.round(mtimeMs)) % 0xffffffffff;
  }
  return acc.toString(36);
}

/**
 * Diagnostics are a local development aid. They are on by default when running
 * outside production and can be turned off explicitly; they never switch on in
 * production, whatever the env says.
 */
export const diagnosticsEnabled = () =>
  process.env.NODE_ENV !== 'production' && process.env.DIAGNOSTICS !== '0';

/**
 * Pixel dimensions straight from the file header — no decoding, no dependency.
 * Lets us compare what the browser says it produced with what actually arrived.
 */
export function imageDimensions(buffer) {
  try {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
        buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      if (buffer.slice(12, 16).toString('ascii') === 'VP8X') {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        };
      }
      return null;
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let i = 2;
      while (i < buffer.length - 9) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1];
        // SOF0-SOF15, excluding DHT/JPG/DAC which share the range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        i += 2 + buffer.readUInt16BE(i + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}
