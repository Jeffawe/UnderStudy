/**
 * Loaded before every test file (see `npm test`). Gives the run its own
 * Understudy home, so tests never write sessions, screenshots or recordings
 * into your real ~/.understudy — and never read the env file saved there,
 * which may point at a cloud cluster. Settings then come from ./.env.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.UNDERSTUDY_HOME ??= mkdtempSync(join(tmpdir(), 'understudy-test-home-'));
