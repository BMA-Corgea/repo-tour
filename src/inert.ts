/**
 * A repository's own words, as a terminal should show them: as text, and nothing else (T-58, T-59).
 *
 * A file's name, a branch's, or a value in a `.repo-tour/` cache a repository committed reaches repo-tour exactly as
 * its author chose it, so an escape sequence in it would run in the reader's terminal (colour, a rewritten screen, a
 * link, a clipboard write) and a newline would forge a line of output. Each control character, and each character
 * that reorders text, is shown as its escape instead. A name without them prints as it always has. One helper, used
 * wherever repo-tour prints such a string.
 */
export function inert(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A whole message of repo-tour's own (several lines) that may carry a repository's words: each of its lines made
 * inert, so it still reads as the lines it was written in. A value with lines of its own is made inert where the
 * message is built, before it gets here.
 */
export function inertLines(s: string): string {
  return s.split('\n').map(inert).join('\n');
}
