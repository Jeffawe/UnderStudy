/**
 * `npm run bedrock:check` — does Mode A actually work?
 *
 * Every adapter in this directory is written but unverifiable until Bedrock
 * model access is granted, which happens in a console this code cannot reach.
 * So the useful thing to ship alongside them is the command that answers "has
 * it landed yet, and does each piece work" in one run, without touching the
 * database or a browser.
 *
 * Each probe is the smallest real call that exercises the path: a structured
 * output for the distiller, a decompose for the reasoner, an embedding for
 * Titan. A pass here means the credentials, the region, the model access and
 * the request shape are all correct.
 *
 * Titan is checked LAST and its failure is not fatal, because the local
 * embedder is the default in both modes — Titan being unavailable does not
 * block Mode A.
 */

import { awsRegion, callJSON, distillerModel, reasonerModel, supportsEffort } from './client.js';
import { BedrockReasoner } from '../reasoner/bedrock.js';
import { TitanEmbedder } from '../embedder/bedrock.js';

const ok = (s: string) => console.log(`  ok    ${s}`);
const bad = (s: string) => console.log(`  FAIL  ${s}`);

async function probe(label: string, fn: () => Promise<string>): Promise<boolean> {
  process.stdout.write(`${label}\n`);
  const started = Date.now();
  try {
    const detail = await fn();
    ok(`${detail}  (${Date.now() - started}ms)`);
    return true;
  } catch (err) {
    bad(err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function main() {
  const DISTILLER = distillerModel();
  const REASONER = reasonerModel();

  console.log(`region:    ${awsRegion()}`);
  console.log(`distiller: ${DISTILLER}${supportsEffort(DISTILLER) ? '' : '  (no effort parameter)'}`);
  console.log(`reasoner:  ${REASONER}\n`);

  // 1 — structured outputs, the feature the distiller depends on. If this
  // works, the distiller's only remaining variable is prompt quality.
  const distiller = await probe(`distiller — structured output via ${DISTILLER}`, async () => {
    const { value, inputTokens, outputTokens } = await callJSON<{ colour: string; count: number }>({
      model: DISTILLER,
      system: 'You answer with JSON matching the schema. Nothing else.',
      user: 'The sky on a clear day, and the number of sides on a triangle.',
      schema: {
        type: 'object',
        required: ['colour', 'count'],
        properties: { colour: { type: 'string' }, count: { type: 'integer' } },
      },
      maxTokens: 200,
    });
    if (typeof value.colour !== 'string' || typeof value.count !== 'number') {
      throw new Error(`schema not honoured: ${JSON.stringify(value)}`);
    }
    return `{colour:"${value.colour}", count:${value.count}}  in=${inputTokens} out=${outputTokens}`;
  });

  // 2 — the real decompose path, against a vocabulary shaped like saucedemo's.
  // Checks the adapter, not just the transport: a wrong-shaped answer throws.
  const reasoner = await probe(`reasoner — decompose via ${REASONER}`, async () => {
    const subGoals = await new BedrockReasoner().decompose('buy a backpack', [
      'segment: log in as a standard user (log-in-standard-user)',
      'segment: add an item to the cart (add-item-to-cart)',
      'segment: complete the checkout form (complete-checkout)',
      'fact: the app requires authentication before the inventory is reachable',
    ]);
    return `${subGoals.length} sub-goal(s): ${subGoals.map((s) => `"${s}"`).join(' -> ')}`;
  });

  // 3 — optional. Local ONNX is the default embedder in both modes.
  const titan = await probe('embedder — Titan (optional; local mxbai is the default)', async () => {
    const embedder = new TitanEmbedder();
    const vector = await embedder.embedQuery('log in as a standard user');
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    // Unit length is not cosmetic: L2 ranking only equals cosine ranking for
    // normalized vectors, and the index is L2.
    if (Math.abs(norm - 1) > 0.01) throw new Error(`vector is not unit length (norm=${norm.toFixed(4)})`);
    return `${vector.length} dims, norm=${norm.toFixed(6)}`;
  });

  console.log('');
  if (distiller && reasoner) {
    console.log('Mode A is live. `understudy test <app> "<goal>" --reasoner bedrock` will now decompose for itself.');
    if (!titan) {
      console.log('Titan is unavailable, which blocks nothing — keep EMBEDDER_ID=mxbai-embed-large.');
    }
  } else {
    console.log('Mode A is not usable yet. Mode B (the MCP server) is unaffected — it needs no AWS at all.');
    process.exitCode = 1;
  }
}

// process.exit() would race the AWS SDK's open sockets; exitCode lets Node
// drain and leaves the real error visible. Same lesson as the ONNX embedder.
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
