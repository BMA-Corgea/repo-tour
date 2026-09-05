/**
 * T-18 — the three citation verdicts (AC9).
 *
 * What matters here is not that links get made. It is that "it read this file" and "it is
 * talking about a file nobody showed it" stop looking identical on the page, because the
 * second is exactly where a confident wrong answer hides.
 */

import { describe, it, expect } from 'vitest';
import { findCitations } from '../src/cite.js';

const REPO = new Set(['src/rank.ts', 'src/server.ts', 'src/build/plan.ts', 'README.md', 'rank.ts']);
const exists = (p: string): boolean => REPO.has(p);

describe('the three verdicts', () => {
  it('trusts a path it was actually given', () => {
    const [c] = findCitations('scored in src/rank.ts:24', ['src/rank.ts'], exists);
    expect(c).toMatchObject({ path: 'src/rank.ts', line: 24, verdict: 'supplied' });
    expect(c!.text).toBe('src/rank.ts:24');
  });

  it('marks a real file that nobody put in front of it', () => {
    const [c] = findCitations('see src/server.ts', ['src/rank.ts'], exists);
    expect(c).toMatchObject({ path: 'src/server.ts', verdict: 'unshown' });
  });

  it('marks a path that is not in the repository at all', () => {
    const [c] = findCitations('handled in src/imaginary.ts', ['src/rank.ts'], exists);
    expect(c).toMatchObject({ path: 'src/imaginary.ts', verdict: 'unknown' });
  });

  it('gives all three, in order, from one answer', () => {
    const found = findCitations(
      'src/rank.ts scores, src/server.ts serves, src/nope.ts does not exist',
      ['src/rank.ts'],
      exists,
    );
    expect(found.map((c) => c.verdict)).toEqual(['supplied', 'unshown', 'unknown']);
  });
});

describe('line numbers', () => {
  it('reads a line', () => {
    expect(findCitations('src/rank.ts:24', ['src/rank.ts'], exists)[0]!.line).toBe(24);
  });

  it('reads a range as its first line, and covers the whole span', () => {
    const [c] = findCitations('src/rank.ts:24-31 is the loop', ['src/rank.ts'], exists);
    expect(c!.line).toBe(24);
    expect(c!.text).toBe('src/rank.ts:24-31');
  });

  it('is happy with no line at all', () => {
    expect(findCitations('src/rank.ts', ['src/rank.ts'], exists)[0]!.line).toBeNull();
  });
});

describe('prose is not accused of being a hallucinated path', () => {
  it('leaves an unmatched bare word alone', () => {
    // The deliberate blind spot: 'Node.js' is shaped exactly like a filename, and telling a
    // reader their assistant invented it would be worse than missing a real bare citation.
    expect(findCitations('this runs on Node.js and needs Vite.js', [], exists)).toEqual([]);
  });

  it('ignores version numbers and decimals', () => {
    expect(findCitations('version 1.2.3, about 3.14 of them', [], exists)).toEqual([]);
  });

  it('still resolves a bare filename when it is genuinely one of the supplied files', () => {
    const [c] = findCitations('rank.ts sorts them', ['src/rank.ts'], exists);
    expect(c).toMatchObject({ path: 'src/rank.ts', verdict: 'supplied' });
  });

  it('refuses to guess when a bare name is ambiguous between two supplied files', () => {
    const found = findCitations('index.ts does it', ['a/index.ts', 'b/index.ts'], (p) => p === 'index.ts' ? false : REPO.has(p));
    expect(found).toEqual([]);
  });

  it('resolves a bare name against the repository root when one is there', () => {
    const [c] = findCitations('README.md explains it', [], exists);
    expect(c).toMatchObject({ path: 'README.md', verdict: 'unshown' });
  });
});

describe('the spans are usable for rendering', () => {
  it('points at exactly the matched text', () => {
    const text = 'the loop in src/build/plan.ts:88 is the cap';
    const [c] = findCitations(text, ['src/build/plan.ts'], exists);
    expect(text.slice(c!.start, c!.end)).toBe('src/build/plan.ts:88');
  });

  it('does not start a match in the middle of a longer path', () => {
    const found = findCitations('src/build/plan.ts', ['src/build/plan.ts'], exists);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe('src/build/plan.ts');
  });

  it('finds a path inside backticks without swallowing them', () => {
    const text = 'look at `src/rank.ts:12` for that';
    const [c] = findCitations(text, ['src/rank.ts'], exists);
    expect(c!.text).toBe('src/rank.ts:12');
    expect(text[c!.start - 1]).toBe('`');
  });

  it('normalises a ./ prefix on both sides', () => {
    const [c] = findCitations('./src/rank.ts is it', ['./src/rank.ts'], exists);
    expect(c).toMatchObject({ path: 'src/rank.ts', verdict: 'supplied' });
  });
});
