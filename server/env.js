/**
 * Loads .env from the project root, then walks up to parent directories.
 * The course keeps a shared PORTKEY_API_KEY at the course-folder root, so a
 * fresh clone inside that folder works without copying the key around.
 * Import this before anything that reads process.env.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

let dir = projectRoot;
for (let i = 0; i < 5; i++) {
  const candidate = join(dir, '.env');
  // Earlier files win: dotenv does not overwrite already-set variables.
  if (existsSync(candidate)) config({ path: candidate, quiet: true });
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

export const PROJECT_ROOT = projectRoot;
