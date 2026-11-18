/**
 * What the in-page recorder sends, and how it becomes a recording step.
 *
 * Shared by both recorders — the Playwright one (live.ts) and the Chrome
 * extension (extension.ts) — so a flow recorded either way produces exactly
 * the same steps. The in-page script itself is injected.ts.
 */

import { redactValue, type RawEvent, type RecordedAction, type Resolution } from '../../core/recording.js';

/** What the in-page script sends for each action. */
export interface WireEvent {
  seq: number;
  action: RecordedAction;
  stamp: number;
  url: string;
  hintRole: string;
  hintName: string;
  /** Which path produced hintRole/hintName in the page: the accname library, or a heuristic. */
  resolvedBy?: 'accname' | 'heuristic';
  css?: string;
  testId?: string;
  testIdAttr?: string;
  inputType?: string;
  frameHint?: string;
  value?: string;
  label?: string;
  /** Files on a file input. The page can count them; it cannot name them. */
  fileCount?: number;
}

/**
 * Turn one wire event into a recording step.
 *
 * `resolved` overrides role/name when the caller could look the element up
 * more reliably (live.ts does, when the page fell back to its heuristic).
 * `value` overrides the typed value — live.ts passes an upload's stored path.
 */
export function toRawEvent(
  wire: WireEvent,
  ts: number,
  opts: { resolved?: { role?: string | null; name?: string | null }; value?: string } = {},
): RawEvent {
  const inPage = wire.resolvedBy === 'accname';
  const role = inPage ? wire.hintRole : (opts.resolved?.role || wire.hintRole);
  const name = inPage ? wire.hintName : (opts.resolved?.name || wire.hintName);
  const resolution: Resolution = inPage || opts.resolved ? 'accname' : 'unresolved';

  // The value-reference name comes from the field's name alone; detection
  // looks at every hint (joining all three once produced
  // `SECRET.password_password_password`).
  const fieldHint = name || wire.testId || wire.css || 'field';
  const secretSignal = [name, wire.css, wire.testId].filter(Boolean).join(' ');

  // A key press's value is a key name ('Enter'), never a credential, and an
  // upload's value is a path. Only typed input can be a secret.
  const valued =
    opts.value !== undefined
      ? { value: opts.value }
      : wire.value !== undefined
        ? wire.action === 'press'
          ? { value: wire.value }
          : redactValue(fieldHint, wire.value, wire.inputType, secretSignal)
        : {};

  return {
    seq: 0,
    ts,
    action: wire.action,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...valued,
    ...(wire.css ? { css: wire.css } : {}),
    ...(wire.testId ? { testId: wire.testId } : {}),
    ...(wire.testIdAttr ? { testIdAttr: wire.testIdAttr } : {}),
    ...(wire.frameHint ? { frameHint: wire.frameHint } : {}),
    url: wire.url,
    resolution,
  };
}
