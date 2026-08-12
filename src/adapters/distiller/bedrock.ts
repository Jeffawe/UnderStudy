/**
 * BedrockDistiller — Mode A's answer to "what does this recording MEAN?"
 *
 * Mode B answers that question by suspending: `promote_recording` returns a
 * payload, the agent reads it, and `save_distilled` hands the answer back. This
 * adapter answers it in one call, ~2s, unattended. Both produce a `Distilled`
 * that `validateDistilled()` has to accept, and `ingest` cannot tell which one
 * it got — that is the point of the seam.
 *
 * THE PROMPT AND SCHEMA ARE NOT MINE TO WRITE. `distill.ts` already owns both,
 * and they ride along inside every `DistillRequest`. Re-authoring them here
 * would mean the two modes drift: the same recording would distil differently
 * depending on who was asked, and the corpus would end up with two vocabularies
 * for the same app. So this file is transport, not instruction.
 *
 * VALIDATION HAPPENS HERE TOO, NOT ONLY AT INGEST. `validateDistilled` runs at
 * the ingest boundary regardless, but catching a bad distillation in the
 * adapter buys a retry with the errors fed back — which is exactly the loop the
 * agent gets in Mode B, and one round trip is far cheaper than a failed ingest
 * that a human has to notice.
 */

import { callJSON, distillerModel } from '../bedrock/client.js';
import { validateDistilled } from '../../core/distill.js';
import type { Distilled, DistillRequest } from '../../core/distill.js';
import type { Distiller } from '../../core/types.js';

/** How many times to hand validation errors back before giving up. */
const MAX_ATTEMPTS = 3;

export class BedrockDistiller implements Distiller {
  readonly id: string;

  constructor(private readonly model: string = distillerModel()) {
    this.id = model;
  }

  async distill(request: DistillRequest): Promise<Distilled> {
    const stepCount = request.steps.length;
    if (!stepCount) throw new Error('nothing to distil: the recording has no replayed steps');

    let corrections: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { value } = await callJSON<unknown>({
        model: this.model,
        system: request.instructions,
        user: renderRequest(request, corrections),
        schema: request.schema,
        // Enough for a long recording's worth of segments; the response is
        // still small enough that non-streaming is safe.
        maxTokens: 8000,
      });

      const check = validateDistilled(value, stepCount);
      if (check.ok) return check.value!;

      // Feed the errors back verbatim. They are specific and index-aware
      // ("segments[2].stepRange [4,99) is outside 0..12"), so a second attempt
      // is usually a correction rather than a re-roll.
      corrections = check.errors;
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `${this.model} failed validation ${MAX_ATTEMPTS} times. Last errors:\n  ` +
            check.errors.join('\n  '),
        );
      }
    }

    /* unreachable — the loop either returns or throws */
    throw new Error('unreachable');
  }
}

/**
 * Render the request as the message body.
 *
 * The steps go in as JSON rather than prose because they are being referenced
 * by index and the indices have to survive: a bulleted list invites the model
 * to renumber. The vocabulary is spelled out in words because it is being
 * matched on meaning, and a bare slug list reads as noise.
 */
function renderRequest(request: DistillRequest, corrections: string[]): string {
  const parts: string[] = [];

  if (corrections.length) {
    // First, because a correction buried under 60 steps gets skimmed past.
    parts.push(
      'YOUR PREVIOUS ANSWER FAILED VALIDATION. Fix exactly these and return the ' +
        'whole object again:\n  ' +
        corrections.join('\n  '),
    );
  }

  parts.push(`APP: ${request.appSlug}\nSTART URL: ${request.startUrl}`);

  const { segments, flows, facts } = request.vocabulary;
  if (segments.length || flows.length || facts.length) {
    const lines = [
      ...segments.map((s) => `  segment "${s.slug}": ${s.intent}`),
      ...flows.map((f) => `  flow "${f.slug}": ${f.intent || f.title}`),
      ...facts.slice(0, 20).map((f) => `  fact: ${f}`),
    ];
    parts.push(`THIS APP'S EXISTING VOCABULARY — reuse these words where they fit:\n${lines.join('\n')}`);
  } else {
    parts.push(
      'THIS APP HAS NO VOCABULARY YET. Whatever you name things here becomes the ' +
        'vocabulary every later recording is matched against, so name them the way ' +
        'someone would ASK for them.',
    );
  }

  parts.push(
    `VERIFIED STEPS (${request.steps.length}, indices 0..${request.steps.length - 1}):\n` +
      JSON.stringify(request.steps, null, 1),
  );

  return parts.join('\n\n');
}
