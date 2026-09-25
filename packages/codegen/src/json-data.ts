/**
 * Render plain data for a generated module as `JSON.parse("…") as T` instead of
 * an object/array literal.
 *
 * TypeScript types a literal element by element and subtype-reduces the union of
 * the element types pairwise, so a table that grows with the project (advisories,
 * procedures, OpenRPC methods) fails the consumer's `tsc` with TS2590 once it
 * passes about a thousand differently shaped elements, and a declared type,
 * `as`, or `satisfies` does not stop the inference. A string is not inferred at
 * all (#823). V8 also parses a JSON string faster than the equivalent literal.
 *
 * Only for data whose declared `type` is its whole contract: nothing may infer
 * from the value. The doubly-encoded string is a valid JS string literal for any
 * input, including `"`, `\`, control characters, and U+2028/U+2029.
 */
const renderJsonData = (value: unknown, type: string): string => `JSON.parse(${JSON.stringify(JSON.stringify(value))}) as ${type}`;

export default renderJsonData;
