/**
 * The shape of every document Understudy stores. One collection per idea:
 *
 *   apps      a website you test
 *   flows     a sequence of steps that does one thing (recordings + segments)
 *   pages     a fingerprint of a page state, and the links out of it
 *   notes     something learned: a fact (changes the plan) or a lesson (changes a step)
 *   findings  "the app is broken here"
 *   runs      one attempt at a goal
 *
 * Steps live inside their flow, because you never want one without the other.
 */

import type { ObjectId } from 'mongodb';
import type { RawEvent } from '../core/recording.js';

export type Precondition = 'authenticated' | 'not authenticated';

/** Kinds of typed value an app can choose to keep as placeholders. Just email, for now. */
export const PLACEHOLDER_KINDS = ['email'] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

/**
 * One action in a flow. Exactly the shape the recorder emits, minus its
 * bookkeeping (`seq` is the array position here; `ts` is not needed).
 */
export type Step = Omit<RawEvent, 'seq' | 'ts'>;

export interface App {
  _id?: ObjectId;
  slug: string;
  name: string;
  /** Base URL per environment, e.g. { local: 'http://localhost:3000' }. */
  urls: Record<string, string>;
  /**
   * Kinds of typed value to keep out of memory as placeholders, beyond the
   * passwords that always are. `email`: email fields become `USER.email`, the
   * value moves to the user's env file. See memory/placeholders.ts.
   */
  placeholders?: PlaceholderKind[];
  createdAt: Date;
}

export interface Flow {
  _id?: ObjectId;
  app: string;
  slug: string;
  title: string;
  /** What the flow is FOR, phrased the way someone would ask for it. */
  intent: string;
  /** A recording is captured whole; a segment is cut from one so others can reuse it. */
  kind: 'recording' | 'segment';
  /**
   * Who made it: 'user' recorded it; 'agent' drove it itself and handed over
   * the script. Both are proven by replay before they're kept. Missing = 'user'
   * (flows saved before this field existed were all recordings).
   */
  madeBy?: 'user' | 'agent';
  /**
   * False when it was kept without a passing replay (skipped, or kept after
   * failing). Missing = proven. The first run that passes sets it back, and
   * fills in what a replay records: the page each step lands on.
   */
  proven?: boolean;
  /** Why it's unproven, e.g. "saved without a replay". */
  unprovenBecause?: string;
  /**
   * Proven only UP TO this step: the first that commits something real (a
   * purchase, a submission) or that only a person can do. Every step before it replayed and passed, and its
   * control was found ready — but it was never pressed, so nothing after it has
   * run. Missing = proven all the way (or not at all: see `proven`). A full run
   * that passes (with purchases allowed) clears it.
   */
  provenUpTo?: number;
  /** Segments only: the flow it was cut from, and which of its steps ([start, end)). */
  from?: { flow: string; steps: [number, number] };
  preconditions: Precondition[];
  /**
   * App states this flow needs before it can run, e.g. "member-has-active-bundle".
   * The page it expects depends on them — the same button leads somewhere else
   * without. A plan satisfies each with an earlier flow that `establishes` it,
   * or with the agent's word that it already holds.
   *
   * Names are kebab-case and belong to the app: reuse an existing one rather
   * than coin a synonym, or the planner never connects the two.
   */
  requires?: string[];
  /** App states this flow makes true, e.g. buying a bundle establishes "member-has-active-bundle". */
  establishes?: string[];
  outcome: string;
  /** True if running it commits something real (a purchase, a submission). */
  destructive: boolean;
  /** Where a capture deliberately stops, and why. Read by whoever picks it up next. */
  corrections: string[];
  /** Why it was marked destructive, e.g. 'commit-shaped control "Place order"'. */
  destructiveBecause?: string;
  /** The recording this flow was saved from (its hash), so it can be traced back. */
  recording: string;
  /** Where replay starts. */
  startUrl: string;
  /** True if the first step needs a signed-in browser (recorded with --arm-manually, or from a signed-in tab). */
  requiresSession: boolean;
  /** The saved session to restore, by id (recorded from a signed-in tab by the Chrome extension). */
  session?: string;
  /** Page fingerprint before the first step / after the last — how flows join up. */
  startState?: string;
  endState?: string;
  /** Each step's `expectedSig` is the page seen after it when the flow was proven. */
  steps: Step[];
  /** The text that gets embedded and searched: title + intent + outcome. */
  searchText: string;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Page {
  _id?: ObjectId;
  app: string;
  /** sig(): `<url pattern>#<8 hex>`. */
  sig: string;
  urlPattern: string;
  /** Known ways out of this page. */
  links: { to: string; via: { role: string; name: string } }[];
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * When a lesson fires: every field present must equal the step's exactly, and
 * an absent field matches anything. Never empty — that would match every step.
 */
export interface Trigger {
  /** The page the step is on, as a URL pattern like `/login` or `/orders/:id`. */
  url_pattern?: string;
  action?: string;
  role?: string;
  name?: string;
}

export interface Note {
  _id?: ObjectId;
  app: string;
  /** fact: changes what you plan. lesson: has a trigger and changes one step. */
  kind: 'fact' | 'lesson';
  text: string;
  /** Lessons only: a short name, unique per app (re-adding one doesn't duplicate it). */
  title?: string;
  /** Lessons only: what kind of fix — `wait`/`timing` make replay settle the page first. */
  lessonKind?: string;
  /** Lessons only. */
  trigger?: Trigger;
  /** Facts only: a control whose click commits something real — flows clicking it are destructive. */
  marksDestructive?: string;
  timesApplied: number;
  /** Fired on a step whose fingerprint has failed before, and the step passed. */
  timesHelped: number;
  searchText: string;
  embedding?: number[];
  createdAt: Date;
}

export interface Finding {
  _id?: ObjectId;
  app: string;
  kind: string;
  severity: 'low' | 'medium' | 'high';
  statement: string;
  evidence: Record<string, unknown>;
  /** Same problem across runs → same fingerprint → one finding, more occurrences. */
  fingerprint: string;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  /**
   * open until someone triages it: a real bug (issue), a workaround (lesson),
   * noise, or — for a changed path — expected: the app changed on purpose, and
   * the new path is the normal one from now on.
   */
  status: 'open' | 'issue' | 'lesson' | 'noise' | 'expected';
}

/**
 * Which embedding model filled this database. Vectors from two models can't be
 * compared, so Understudy refuses to start if .env names a different one.
 * Lives in the one-document `meta` collection.
 */
export interface EmbedderMeta {
  _id: 'embedder';
  model: string;
  dims: number;
  setAt: Date;
}

export interface Run {
  _id?: ObjectId;
  app: string;
  goal: string;
  /**
   * run: planned from a goal. replay: one flow, verbatim.
   * attributed: an agent reached the goal by other means and reported it.
   */
  mode: 'run' | 'replay' | 'attributed';
  /**
   * The run stopped, as asked, before this step — the flow's commit — rather
   * than doing it. Its path is partial, so it is never drift history.
   */
  stoppedBefore?: number;
  /**
   * false: it passed, but its path changed (new pages, or a step landing
   * somewhere unexpected), and nobody has said that's right yet. Kept out of
   * drift history until its finding is triaged `expected` — otherwise a wrong
   * ending that passes becomes "normal" after a few runs. Missing = accepted.
   */
  accepted?: false;
  /** Where each flow of `plan` starts in `steps`, so an accepted path can update each flow. */
  starts?: number[];
  /**
   * waiting: planning paused on a question for the agent (`question` says what).
   * planned: a dry run — the plan is complete, nothing ran.
   * blocked: the plan can't be completed (a sub-goal with no flow, a gap between flows).
   */
  status: 'waiting' | 'planned' | 'passed' | 'failed' | 'blocked';
  /** The flow slugs bound, in order. */
  plan: string[];
  /** One line per step: what it did and where it ended up. `fingerprint` identifies the step across runs. */
  steps: { seq: number; action: string; ok: boolean; sig?: string; error?: string; fingerprint?: string }[];
  /** The page fingerprints actually passed through — compared across runs for drift. */
  sigSequence: string[];
  /** Console errors, failed requests, non-2xx responses (first 200). */
  events: Record<string, unknown>[];
  /** Fingerprints of the findings this run raised. */
  findings: string[];
  durationMs: number;
  /** Set while status is 'waiting': the question the agent must answer. */
  question?: Record<string, unknown>;
  /** Why the run is blocked, in one line. */
  blockedBecause?: string;
  /** Planning progress, so a run can pause for a question and pick up where it left off. */
  planning?: {
    subGoals?: string[];
    /** Flow slug bound to each sub-goal, in order. */
    bound?: string[];
    /** Steps to insert BEFORE plan[i], for i ≥ 1. Missing entry = not resolved yet. */
    seams?: Record<string, { steps: Step[]; how: string }>;
    /** How each required state was satisfied: by running a flow first, or because it already holds. */
    states?: Record<string, { use: string } | { holds: true }>;
    dryRun?: boolean;
    allowPurchases?: boolean;
  };
  startedAt: Date;
  endedAt?: Date;
}
