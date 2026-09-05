/**
 * The two-level narration builder — the single place that decides what a stop shows
 * before you press, and what it shows after.
 *
 * Why this is its own module rather than a helper inside each tour builder: there are two
 * tour kinds now (a repo tour and a PR tour) rendering into one surface, and a reader
 * should not be able to tell which builder produced the stop they are looking at. Two
 * implementations of "how long is the short version" drift within a week. T-5 criterion 14
 * is a test that both builders call THIS function.
 *
 * The rule it enforces (T-5 §8, from the owner's correction at the spec gate): the default
 * level is the whole explanation COMPRESSED, never a selection between the interpretation's
 * fields. `what` and `why` are equally likely to hold the point; showing one and hiding the
 * other would bury the best sentence on the page about half the time.
 */

import { SUMMARY_MAX } from './interpret.js';
import type { CodeStep } from './codetour.js';

export interface Narration {
  /** what the reader sees before pressing anything. Never empty, never over SUMMARY_MAX. */
  summary: string;
  /**
   * The full explanation, byte-identical to what the tour rendered before two-level
   * narration existed. Criterion 12 pins this: expanding must restore the original, so
   * nothing here may "improve" the text on its way through.
   */
  full: string;
  /** false when the full text says nothing the summary did not — the press is pointless. */
  expandable: boolean;
}

/**
 * Compress deterministic narration.
 *
 * Used for stops the interpret stage never saw — synthetic stops, architecture stops, and
 * every stop on a run made with no model. These have no model-written summary, so the
 * short form is taken from the text itself: whole sentences up to the budget, never a
 * mid-word cut. A skimmer reading a clipped sentence learns less than one reading a
 * shorter whole one.
 */
export function compress(text: string, max: number = SUMMARY_MAX): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;

  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  if (sentences) {
    let out = '';
    for (const s of sentences) {
      if ((out + s).trim().length > max) break;
      out += s;
    }
    const trimmed = out.trim();
    // A single opening sentence longer than the budget leaves `out` empty — fall through
    // to the hard cut rather than returning nothing.
    if (trimmed.length > 0) return trimmed;
  }

  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Decide both levels for one stop.
 *
 * An interpreted stop carries a model-written summary; anything else is compressed from
 * its own deterministic text. Either way every stop gets a summary — criterion 11 is
 * "every stop has one", not "most stops have one", because a tour where some bubbles are
 * short and others are essays is worse than either alone.
 */
export function narrate(step: Pick<CodeStep, 'text' | 'summary'>): Narration {
  const full = step.text;
  const written = (step.summary ?? '').trim();
  const summary = written.length > 0 ? written : compress(full);
  return {
    summary,
    full,
    expandable: full.trim().length > summary.length + 8,
  };
}
