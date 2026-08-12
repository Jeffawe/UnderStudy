/**
 * The Bedrock call surface — Mode A's single door to a model.
 *
 * Both adapters above this file (distiller, reasoner) do the same mechanical
 * thing: send a system prompt plus a payload, get JSON back in a known shape.
 * That shared middle is here so each adapter is only about its own question.
 *
 * TWO SDKs, DELIBERATELY. Claude goes through `AnthropicBedrockMantle` — a real
 * Messages API with structured outputs. Titan (see ../embedder/bedrock.ts) is
 * not an Anthropic model and goes through plain `InvokeModel`. Routing Titan
 * through the Mantle client would not work, and routing Claude through
 * `InvokeModel` would throw away structured outputs, which is the feature that
 * makes distillation safe to automate.
 *
 * SCHEMA-CONSTRAINED, NOT PROMPT-BEGGED. Every call here sets
 * `output_config.format`, so the model is constrained to emit conforming JSON
 * rather than asked nicely to. That matters most for the distiller: the
 * alternative is a parse-retry loop that costs a second call every time the
 * model wraps its answer in prose.
 *
 * NO `thinking` PARAMETER ANYWHERE. The default is already right on both
 * models, and they disagree about what the default IS — Sonnet 5 thinks
 * adaptively when the field is absent, Haiku 4.5 doesn't think at all. Passing
 * it explicitly would mean branching per model to say what each already does.
 */

// Config lives in .env, and this module can be imported before anything that
// touches the database — so it loads its own env rather than relying on
// core/db.ts having been imported first. dotenv is idempotent.
import 'dotenv/config';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { APIError } from '@anthropic-ai/sdk';

/**
 * Read at CALL time, not module-init time.
 *
 * As consts these were evaluated when the module was first imported, which in
 * the CLI happens two imports before `core/db.ts` runs `dotenv/config` — so a
 * region set in .env was read as undefined and silently replaced by the
 * default. Functions make the whole thing independent of import order, which
 * is not something any caller should have to reason about.
 *
 * Bedrock model ids carry an `anthropic.` prefix. A first-party id
 * (`claude-haiku-4-5`) reaches Bedrock and 404s, so the prefix is not cosmetic.
 */
export const distillerModel = (): string => process.env.DISTILLER_MODEL ?? 'anthropic.claude-haiku-4-5';
export const reasonerModel = (): string => process.env.REASONER_MODEL ?? 'anthropic.claude-sonnet-5';
export const awsRegion = (): string => process.env.AWS_REGION ?? 'us-east-1';

/**
 * Haiku 4.5 ERRORS on `output_config.effort` — it predates the effort
 * parameter. Since the model is configurable, an effort hint that is correct
 * for the default reasoner would break the moment someone points
 * `REASONER_MODEL` at Haiku to save money. So effort is a request the caller
 * makes and this gate honours only where it is supported.
 */
export const supportsEffort = (model: string): boolean => !/haiku/i.test(model);

let client: AnthropicBedrockMantle | undefined;

/**
 * One client, reused. Construction resolves the AWS credential chain, which
 * hits disk (and possibly IMDS) — doing that per call would add latency to
 * every distillation for no benefit.
 *
 * Credentials are NOT passed explicitly: the chain already covers env vars, a
 * named profile, SSO, and instance roles, which is exactly the range between a
 * laptop and the Oracle box. Reading `AWS_ACCESS_KEY_ID` by hand here would
 * break the other four.
 */
export function getBedrock(): AnthropicBedrockMantle {
  client ??= new AnthropicBedrockMantle({ awsRegion: awsRegion() });
  return client;
}

export interface JsonCall {
  model: string;
  /** Instructions. Stable across calls, so it is the cacheable prefix. */
  system: string;
  /** The payload being reasoned about. */
  user: string;
  /** JSON Schema the response is constrained to. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface JsonResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Ask for JSON, get JSON — or throw with something worth reading.
 *
 * Non-streaming on purpose. Every response here is small (a handful of segments
 * or sub-goals), so the streaming machinery would buy nothing, and
 * `max_tokens` stays well under the threshold where non-streaming risks an HTTP
 * timeout.
 */
export async function callJSON<T>(call: JsonCall): Promise<JsonResult<T>> {
  const { model, system, user, schema } = call;

  let message;
  try {
    message = await getBedrock().messages.create({
      model,
      max_tokens: call.maxTokens ?? 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: {
        format: { type: 'json_schema', schema },
        ...(call.effort && supportsEffort(model) ? { effort: call.effort } : {}),
      },
    });
  } catch (err) {
    throw explain(err, model);
  }

  // A refusal is a successful HTTP 200 with no usable content. Reading
  // content[0] without checking would throw somewhere far less informative.
  if (message.stop_reason === 'refusal') {
    throw new Error(
      `${model} declined this request (${message.stop_details?.category ?? 'no category'}). ` +
        'Nothing was returned.',
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `${model} hit max_tokens before finishing — the JSON is truncated and unparseable. ` +
        'Raise maxTokens, or distil a shorter recording.',
    );
  }

  const text = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text.trim()) throw new Error(`${model} returned no text content`);

  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    // Structured outputs make this close to unreachable, which is exactly why
    // it is worth showing the payload when it does happen.
    throw new Error(`${model} returned unparseable JSON: ${text.slice(0, 300)}`);
  }

  return {
    value,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

/**
 * Turn an API error into the sentence that names the actual fix.
 *
 * The first error anyone hits on this path is a 403 for a model whose access
 * was never granted in the Bedrock console — and the raw message says
 * "AccessDeniedException" without mentioning that a console checkbox is the
 * cure. Since model access is the standing prerequisite for Mode A, spelling it
 * out is worth the eight lines.
 */
function explain(err: unknown, model: string): Error {
  if (!(err instanceof APIError)) return err instanceof Error ? err : new Error(String(err));

  const where = `${model} in ${awsRegion()}`;

  // NO STATUS MEANS THE REQUEST NEVER LEFT. The SDK wraps client-side failures
  // — credential resolution above all — in the same APIError type, with
  // `status` undefined. Falling through to the default branch printed "Bedrock
  // error undefined", which is strictly worse than the message it was
  // replacing, and this is the first thing anyone hits on a fresh machine.
  if (typeof err.status !== 'number') {
    return /credential/i.test(err.message)
      ? new Error(
          'No AWS credentials found. The chain looks for AWS_ACCESS_KEY_ID / ' +
            'AWS_SECRET_ACCESS_KEY, then AWS_PROFILE, then an instance role — set one ' +
            `in .env. (${err.message})`,
        )
      : new Error(`Could not reach Bedrock for ${where}: ${err.message}`);
  }

  switch (err.status) {
    case 403:
      return new Error(
        `Bedrock refused access to ${where}. Usually this means model access was never ` +
          'granted: Bedrock console -> Model access -> enable this model, in this region. ' +
          `It can also mean the IAM principal lacks bedrock:InvokeModel. (${err.message})`,
      );
    case 401:
      return new Error(
        `Bedrock could not authenticate for ${where}. No usable credentials in the chain — ` +
          'set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or AWS_PROFILE. ' +
          `(${err.message})`,
      );
    case 404:
      return new Error(
        `Bedrock has no model "${model}" in ${awsRegion()}. Check the id carries the ` +
          `"anthropic." prefix and that the model is offered in this region. (${err.message})`,
      );
    case 429:
      return new Error(
        `Bedrock rate-limited ${where} after the SDK's own retries. (${err.message})`,
      );
    default:
      return new Error(`Bedrock error ${err.status} on ${where}: ${err.message}`);
  }
}
