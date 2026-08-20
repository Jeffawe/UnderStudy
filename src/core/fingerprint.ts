/**
 * A step's fingerprint: `sha1(action|role|name|url_pattern)`.
 *
 * Two recordings doing the same thing produce byte-identical fingerprints,
 * which is what lets macro mining spot a recurring block, destructive
 * inference match a step against an already-destructive one, and — see
 * `markApplied` — a lesson ask whether the KIND of step it guards has ever
 * actually failed.
 *
 * Lives in its own module because those three callers have nothing else in
 * common, and importing all of `ingest.ts` to get one hash function drags a
 * replay/embedding dependency into places that need neither.
 */

import { createHash } from 'node:crypto';
import { urlPattern } from './sig.js';
import type { RawEvent } from './recording.js';

export function stepFingerprint(event: RawEvent): string {
  return createHash('sha1')
    .update([event.action, event.role ?? '', event.name ?? '', urlPattern(event.url)].join('|'))
    .digest('hex')
    .slice(0, 16);
}
