/**
 * ES reserved words: names that are a syntax error as an ES module binding.
 *
 * `emit/drizzle.ts` interpolates the table name raw into a bare
 * `const ${name} = sqliteTable(...)` binding (and into `.references((): AnySQLiteColumn => ${name}._id)`
 * for every FK) — a table named after a keyword produces a syntax error in the
 * generated Drizzle module, not a type error, so this must be rejected at
 * discovery time. Kept as a separate set from `RESERVED_TABLE_NAMES`: that one
 * is about `ctx.db` member shadowing, this one is about generated-code syntax.
 * If `emit/drizzle.ts` ever stops emitting table names as bare `const` bindings, this
 * check becomes unnecessary.
 *
 * Scope is "illegal as a `const` binding in an ES module", which is wider than
 * the unconditional keyword list: `await` and `yield` are reserved only in a
 * module / strict-mode context, and `eval` / `arguments` are not reserved words
 * at all yet `const eval = …` is still a SyntaxError under strict mode (which an
 * ES module always is). All four fail identically in the emitted Drizzle module.
 */
const RESERVED_JS_WORDS: ReadonlySet<string> = new Set([
    "arguments",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
]);

/**
 * Whether `name` can be an ES module binding: an identifier that is not a
 * reserved word (`default`, `delete`, …). Generated code imports and declares
 * export names, class names and binding names as bindings.
 */
/** An ASCII JavaScript identifier. */
const IDENTIFIER = /^[$A-Z_a-z][\w$]*$/u;

const isBindingName = (name: string): boolean => IDENTIFIER.test(name) && !RESERVED_JS_WORDS.has(name);

export { isBindingName, RESERVED_JS_WORDS };
