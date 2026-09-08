/**
 * Blank out a source file's comments and string literals, so an
 * identifier-or-call probe over the result sees code and only code.
 *
 * A scan rather than a parser: its callers are build-time integration hooks with
 * no parser dependency, and the question is only "does this name appear
 * somewhere that executes". Matching the raw file instead is how a name written
 * in a COMMENT came to satisfy a check — and the file explaining why a line is
 * load-bearing is the same file whose comment then hides that the line is gone.
 *
 * Spans are replaced with spaces rather than deleted, so nothing that was
 * separated becomes adjacent, and line structure survives.
 *
 * Known ceilings. Narrowing either needs real parsing:
 *
 * - A template literal that BOTH interpolates and mentions the name in its
 *   string part still reads as code, so a probe sees a marker that never runs —
 *   the one direction that is SILENT, since a check clears on it.
 * - A quote this scan cannot see as part of a literal opens a string match that
 *   swallows real code up to the next quote: a regex literal (`/["']/u`), or JSX
 *   text carrying an apostrophe. A probe then sees LESS than the file has, so a
 *   check warns about wiring that is present — noisy, not silent.
 */

/** `/* … *\/`, non-greedy so it ends at the FIRST `*\/`. */
const BLOCK_COMMENT = String.raw`\/\*[\s\S]*?\*\/`;
/** `// …` to end of line. */
const LINE_COMMENT = String.raw`\/\/[^\n]*`;
/** `"…"`, honouring backslash escapes and never crossing a newline. */
const DOUBLE_QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"`;
/** `'…'`, the same rules as {@link DOUBLE_QUOTED}. */
const SINGLE_QUOTED = String.raw`'(?:[^'\\\n]|\\.)*'`;

/**
 * A template literal with NO `${…}` in it (that is what the `\$(?!\{)` guard
 * costs). One that interpolates is deliberately left alone: its interpolations
 * are real code, and blanking the whole literal would hide a call written inside
 * one.
 *
 * The delimiter is written `\x60` rather than an escaped backtick because
 * `String.raw` would keep that backslash, and `\`` is not a legal escape in a
 * unicode-mode pattern.
 */
const PLAIN_TEMPLATE = String.raw`\x60(?:[^\x60\\$]|\\.|\$(?!\{))*\x60`;

/**
 * Comments and string literals, matched left to right in ONE alternation so
 * whichever construct OPENS first wins: a quote inside a comment is part of that
 * comment, and a `//` inside a string is part of that string. That ordering is
 * the whole trick — it is what a hand-rolled mode machine buys you, without the
 * machine. Assembled from the named parts above rather than written as one
 * literal, because as a literal it is unreadable.
 */
const SKIPPABLE_RE = new RegExp([BLOCK_COMMENT, LINE_COMMENT, DOUBLE_QUOTED, SINGLE_QUOTED, PLAIN_TEMPLATE].join("|"), "gu");

/** Every character except a newline — line structure survives when a span is blanked. */
const NON_NEWLINE_RE = /[^\n]/gu;

const blanked = (span: string): string => span.replaceAll(NON_NEWLINE_RE, " ");

const codeOnly = (source: string): string => source.replaceAll(SKIPPABLE_RE, blanked);

/**
 * Comments blanked, string literals kept — for a probe that has to read a
 * specifier (`export * from "…/lunora/…"`), which {@link codeOnly} erases.
 *
 * Runs the same alternation so the same "whichever opens first wins" ordering
 * applies: a `//` inside `"https://…"` belongs to the string and survives.
 */
const withoutComments = (source: string): string =>
    source.replaceAll(SKIPPABLE_RE, (span) => (span.startsWith("//") || span.startsWith("/*") ? blanked(span) : span));

export { codeOnly, withoutComments };
