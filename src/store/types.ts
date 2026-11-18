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
 * See REWRITE.md for the reasoning.
 */

import type { ObjectId } from 'mongodb';
import type { RawEvent } from '../core/recording.js';

export type Precondition = 'authenticated' | 'not authenticated';

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
  /** Segments only: which recording, and which steps (inclusive). */
  from?: { recording: string; steps: [number, number] };
  preconditions: Precondition[];
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
  /** True if the first step needs a signed-in browser (recorded with --arm-manually). */
  requiresSession: boolean;
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

/** When a lesson fires: every present field must match the step exactly. */
export interface Trigger {
  url?: string;
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
  /** Lessons only. Never empty — an empty trigger would match every step. */
  trigger?: Trigger;
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
  /** open until someone triages it: a real bug (issue), a workaround (lesson), or noise. */
  status: 'open' | 'issue' | 'lesson' | 'noise';
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
  status: 'running' | 'waiting' | 'passed' | 'failed' | 'blocked';
  /** The flow slugs bound, in order. */
  plan: string[];
  /** One line per step: what it did and where it ended up. */
  steps: { seq: number; action: string; ok: boolean; sig?: string; error?: string }[];
  /** The page fingerprints actually passed through — compared across runs for drift. */
  sigSequence: string[];
  /** Console errors, failed requests, non-2xx responses (first 200). */
  events: Record<string, unknown>[];
  /** Fingerprints of the findings this run raised. */
  findings: string[];
  durationMs: number;
  /** Set while status is 'waiting': the question the agent must answer. */
  question?: Record<string, unknown>;
  startedAt: Date;
  endedAt?: Date;
}
