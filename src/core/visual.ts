/**
 * Visual checkpoints — the one class of defect the rest of this system is blind to.
 *
 * Everything else Understudy notices is structural or behavioural: a console
 * error, a non-2xx body, a locator that matched nothing, a page fingerprint
 * that moved. None of it can see that the Submit button is now white on white,
 * that a panel collapsed to zero height, or that the price renders as NaN.
 * `sig()` deliberately fingerprints STRUCTURE — url pattern, title, landmarks,
 * control names — so a page can be visually destroyed while its sig is
 * unchanged.
 *
 * WHY THE JUDGE IS A MODEL AND THE FILTER IS NOT.
 *
 * Pixel diffing alone is famously unusable: a changed timestamp, an animation
 * frame mid-flight, font hinting on a different machine — all produce diffs,
 * and none of them are bugs. A threshold cannot tell "the date moved" from
 * "the button is gone", so a threshold-only system trains people to ignore it.
 *
 * So this file does only the cheap, deterministic half: capture, compare,
 * produce a ratio. Anything above the floor is handed to the reasoner WITH THE
 * IMAGES, and it decides what the change means. Same ladder as everywhere else
 * — free mechanical checks first, the model last, and only on what survived.
 *
 * WHERE THE CHECKPOINTS COME FROM. Not every step: a run would produce sixty
 * images and drown the judge. The imported spec already says where visuals
 * matter — its `checkpoint(...)` / `toHaveScreenshot(...)` calls are a human's
 * own judgement about which moments are worth a picture. That is far better
 * signal than any heuristic this file could invent, and it was being discarded.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/** Gitignored: these are large, machine-local, and regenerable. */
export const SHOTS_DIR = process.env.UNDERSTUDY_SHOTS_DIR ?? resolve('.understudy/shots');

/**
 * Below this fraction of changed pixels, say nothing.
 *
 * Antialiasing and subpixel text rendering alone move a few hundred pixels on
 * a full-page shot. Escalating those would make every run produce a question.
 */
export const VISUAL_MIN = 0.002;

/**
 * Above this, stop the run rather than drive forty more steps into it.
 *
 * A third of the page changing is not a moved button — it is a blank render,
 * an error screen, or a layout that collapsed. `sig()` can miss all three,
 * because landmarks and control names survive a page that looks destroyed.
 */
export const VISUAL_SEVERE = 0.35;

export interface VisualCheck {
  seq: number;
  /** The name the spec gave this checkpoint, e.g. "02-review-summary". */
  label: string;
  currentPath: string;
  baselinePath?: string;
  /** Where the highlighted difference was written, when there was one. */
  diffPath?: string;
  /** Fraction of pixels that differ. Undefined when there was no baseline. */
  ratio?: number;
  /** First sighting of this label — it BECOMES the baseline, nothing to judge. */
  isNew: boolean;
  /** Dimensions changed, so a pixel comparison is meaningless. */
  resized?: boolean;
}

const baselinePathFor = (appSlug: string, label: string): string =>
  join(SHOTS_DIR, appSlug, 'baseline', `${label}.png`);

const currentPathFor = (appSlug: string, runId: string, label: string): string =>
  join(SHOTS_DIR, appSlug, 'runs', runId, `${label}.png`);

async function write(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/**
 * Take the shot, compare it to the baseline, and report.
 *
 * `fullPage` and the toast mask are both copied from the spec helper this
 * replaces — a run-to-run popup on a timer is exactly the kind of thing that
 * makes pixel comparison worthless, and whoever wrote that helper had already
 * been bitten by it.
 */
export async function captureCheckpoint(
  page: Page,
  opts: { appSlug: string; runId: string; seq: number; label: string },
): Promise<VisualCheck> {
  const { appSlug, runId, seq, label } = opts;

  const shot = await page.screenshot({
    fullPage: true,
    mask: [page.getByRole('status'), page.getByRole('alert')],
  });

  const currentPath = currentPathFor(appSlug, runId, label);
  await write(currentPath, shot);

  const baselinePath = baselinePathFor(appSlug, label);
  if (!existsSync(baselinePath)) {
    // FIRST SIGHTING IS THE BASELINE. There is nothing to judge against, and
    // inventing a verdict here would be pure noise on every new checkpoint.
    await write(baselinePath, shot);
    return { seq, label, currentPath, baselinePath, isNew: true };
  }

  const baseline = PNG.sync.read(await readFile(baselinePath));
  const current = PNG.sync.read(shot);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    // A full-page shot changes height whenever content does, so this is common
    // and NOT automatically a defect — but a pixel ratio would be nonsense.
    return {
      seq, label, currentPath, baselinePath, isNew: false, resized: true,
      ratio: 1,
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const changed = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    baseline.width,
    baseline.height,
    // Slightly forgiving: below this, a pixel counts as unchanged. Text
    // rendering differs by a shade or two between runs on the same machine.
    { threshold: 0.15, includeAA: false },
  );

  const ratio = changed / (baseline.width * baseline.height);
  if (ratio < VISUAL_MIN) {
    return { seq, label, currentPath, baselinePath, ratio, isNew: false };
  }

  const diffPath = currentPath.replace(/\.png$/, '.diff.png');
  await write(diffPath, PNG.sync.write(diff));
  return { seq, label, currentPath, baselinePath, diffPath, ratio, isNew: false };
}

/** Checks worth a judgement — everything below the floor is dropped. */
export const worthJudging = (checks: VisualCheck[]): VisualCheck[] =>
  checks.filter((c) => !c.isNew && (c.ratio ?? 0) >= VISUAL_MIN);

/** Accept the current shot as the new truth, once a change is judged expected. */
export async function acceptBaseline(check: VisualCheck): Promise<void> {
  if (!check.baselinePath) return;
  await write(check.baselinePath, await readFile(check.currentPath));
}
