/**
 * Characters `JSON.stringify` leaves raw that are still unsafe once the emitted
 * source travels: `<` / `>` / `/` can close a host `</script>` if the file is
 * ever inlined into HTML (a code viewer, a docs page), and U+2028 / U+2029 are
 * line terminators that older tooling treats as breaking the literal. Their
 * escaped forms denote the identical string, so this costs nothing.
 */
const LITERAL_UNSAFE = /[\u003C\u003E\u002F\u2028\u2029]/g;

const LITERAL_UNSAFE_ESCAPES: Readonly<Record<string, string>> = {
    "\u002F": String.raw`\u002F`,
    "\u2028": String.raw`\u2028`,
    "\u2029": String.raw`\u2029`,
    "\u003C": String.raw`\u003C`,
    "\u003E": String.raw`\u003E`,
};

/**
 * Emit `value` as a TypeScript string literal.
 *
 * Every value spliced into generated source goes through this: database identifiers,
 * package specifiers and file paths can contain `"`, `\` or a newline, and the output
 * is code that runs. Splicing a raw value into a quoted literal is a code-injection hole.
 *
 * `JSON.stringify` handles quotes, backslashes, and control characters;
 * {@link LITERAL_UNSAFE} covers the rest, so the result is safe both as TypeScript
 * and in any downstream context the generated file gets embedded in.
 */
const literal = (value: string): string => JSON.stringify(value).replaceAll(LITERAL_UNSAFE, (character) => LITERAL_UNSAFE_ESCAPES[character] ?? character);

export default literal;
