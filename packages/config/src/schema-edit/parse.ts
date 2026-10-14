/**
 * Validator-aware reader for a `lunora/schema.ts` source string, used by the
 * visual schema editor (plan 024). Extends `.vis/templates/_helpers/parse-schema.ts`
 * (which only reads column names) to also carry each column's validator
 * expression text (e.g. `v.string()`, `v.optional(v.number())`) and the
 * declared indexes, so the editor can render typed columns and detect
 * whether a column is optional.
 *
 * Pure string-in / structured-out over an in-memory ts-morph project — no I/O.
 * Only the literal identifier `defineSchema` / `defineTable` is matched; an
 * aliased import is reported via {@link ParseSchemaResult} so callers surface an
 * unsupported-edit response rather than guessing.
 */
import type { CallExpression, Node, ObjectLiteralExpression, PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

/** A single declared column: its name and the raw validator expression text. */
interface SchemaColumn {
    /** Column key (quotes stripped). */
    readonly name: string;
    /** Whether the validator is wrapped in `v.optional(...)`. */
    readonly optional: boolean;
    /** Raw validator expression text, e.g. `v.string()` or `v.optional(v.number())`. */
    readonly validator: string;
}

/** A declared secondary index on a table. */
interface SchemaIndex {
    /** Fields the index covers, in declaration order. */
    readonly fields: ReadonlyArray<string>;
    /** Index name. */
    readonly name: string;
    /** Whether the index was declared `{ unique: true }`. */
    readonly unique: boolean;
}

/** One table parsed from `defineSchema({ ... })`. */
interface SchemaTable {
    readonly columns: ReadonlyArray<SchemaColumn>;
    /** Whether the table is `.global()`. */
    readonly global: boolean;
    readonly indexes: ReadonlyArray<SchemaIndex>;
    readonly name: string;
    /** The `.shardBy("field")` key, if any. */
    readonly shardBy?: string;
}

/** Result of parsing a schema source string. */
type ParseSchemaResult =
    { ok: false; reason: "aliased-define-schema" | "no-define-schema" | "non-object-argument" } | { ok: true; tables: ReadonlyArray<SchemaTable> };

const OPTIONAL_VALIDATOR_PATTERN = /^v\s*\.\s*optional\s*\(/u;
const SHARD_BY_PATTERN = /\.shardBy\(\s*["']([^"']+)["']\s*\)/u;
// Matches both `.global()` and `.global({ backend: "hyperdrive" })` — the latter
// is what `lunora introspect` emits for a table whose rows live in an external database.
const GLOBAL_PATTERN = /\.global\(\s*(?:\{[^{}]*\}\s*)?\)/u;
const QUOTE_PATTERN = /["']/gu;

/**
 * Every `CallExpression` at or below a node. `getDescendantsOfKind` excludes the
 * node itself, but a table initializer often is the outermost call in the
 * `defineTable(...).global().index(...)` chain, so include it explicitly.
 */
const collectCalls = (node: Node): CallExpression[] => {
    const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression);

    if (node.getKind() === SyntaxKind.CallExpression) {
        calls.push(node.asKindOrThrow(SyntaxKind.CallExpression));
    }

    return calls;
};

/** True when the validator expression text is wrapped in `v.optional(...)`. */
const isOptionalValidator = (validatorText: string): boolean => OPTIONAL_VALIDATOR_PATTERN.test(validatorText.trim());

/** Read the string elements of an `["a", "b"]` array literal argument. */
const readStringArray = (node: Node | undefined): string[] => {
    if (node?.getKind() !== SyntaxKind.ArrayLiteralExpression) {
        return [];
    }

    return node
        .asKindOrThrow(SyntaxKind.ArrayLiteralExpression)
        .getElements()
        .filter((element) => element.getKind() === SyntaxKind.StringLiteral)
        .map((element) => element.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
};

/** Whether an `.index(...)` options object declares `{ unique: true }`. */
const readUnique = (node: Node | undefined): boolean => {
    if (node?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return false;
    }

    const property = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperty("unique");

    return property?.getKind() === SyntaxKind.PropertyAssignment && (property as PropertyAssignment).getInitializer()?.getText() === "true";
};

/** Parse one `.index(...)` call into a {@link SchemaIndex}, or `undefined`. */
const parseIndexCall = (call: CallExpression): SchemaIndex | undefined => {
    const expression = call.getExpression();

    if (expression.getKind() !== SyntaxKind.PropertyAccessExpression || expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName() !== "index") {
        return undefined;
    }

    const [nameArgument, fieldsArgument, optionsArgument] = call.getArguments();

    if (nameArgument?.getKind() !== SyntaxKind.StringLiteral) {
        return undefined;
    }

    return {
        fields: readStringArray(fieldsArgument),
        name: nameArgument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText(),
        unique: readUnique(optionsArgument),
    };
};

/** Read every `.index(...)` off a table's initializer chain. */
const parseIndexes = (initializer: PropertyAssignment): SchemaIndex[] => {
    const initializerNode = initializer.getInitializer();

    if (initializerNode === undefined) {
        return [];
    }

    const indexes: SchemaIndex[] = [];

    for (const call of collectCalls(initializerNode)) {
        const index = parseIndexCall(call);

        if (index !== undefined) {
            indexes.push(index);
        }
    }

    return indexes;
};

/** Read the columns of a `defineTable({ ... })` shape, validator text included. */
const parseColumns = (initializer: PropertyAssignment): SchemaColumn[] => {
    const columns: SchemaColumn[] = [];
    const initializerNode = initializer.getInitializer();
    const defineTableCall =
        initializerNode === undefined ? undefined : collectCalls(initializerNode).find((call) => call.getExpression().getText() === "defineTable");
    const tableShape = defineTableCall?.getArguments()[0];

    if (tableShape?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return columns;
    }

    for (const property of (tableShape as ObjectLiteralExpression).getProperties()) {
        if (property.getKind() !== SyntaxKind.PropertyAssignment) {
            continue;
        }

        const assignment = property as PropertyAssignment;
        const name = assignment.getName().replaceAll(QUOTE_PATTERN, "");
        const validator = assignment.getInitializer()?.getText() ?? "";

        columns.push({ name, optional: isOptionalValidator(validator), validator });
    }

    return columns;
};

/**
 * Parse the tables (with typed columns + indexes) out of a `lunora/schema.ts`
 * source string. Returns a tagged result so callers can render a helpful
 * message per failure mode without throwing.
 */
const parseSchema = (source: string): ParseSchemaResult => {
    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    const defineSchemaCall = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getText() === "defineSchema");

    if (defineSchemaCall === undefined) {
        // Distinguish "the file aliases the import" from "there is no schema at
        // all", so the editor can explain that aliasing is unsupported.
        const aliased = sourceFile
            .getImportDeclarations()
            .some((declaration) => declaration.getNamedImports().some((named) => named.getName() === "defineSchema" && named.getAliasNode() !== undefined));

        return { ok: false, reason: aliased ? "aliased-define-schema" : "no-define-schema" };
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return { ok: false, reason: "non-object-argument" };
    }

    const tables: SchemaTable[] = [];

    for (const property of (tablesArgument as ObjectLiteralExpression).getProperties()) {
        if (property.getKind() !== SyntaxKind.PropertyAssignment) {
            continue;
        }

        const assignment = property as PropertyAssignment;
        const name = assignment.getName().replaceAll(QUOTE_PATTERN, "");
        const initializerText = assignment.getInitializer()?.getText() ?? "";

        const shardMatch = SHARD_BY_PATTERN.exec(initializerText);

        tables.push({
            columns: parseColumns(assignment),
            global: GLOBAL_PATTERN.test(initializerText),
            indexes: parseIndexes(assignment),
            name,
            ...(shardMatch?.[1] === undefined ? {} : { shardBy: shardMatch[1] }),
        });
    }

    return { ok: true, tables };
};

export type { ParseSchemaResult, SchemaColumn, SchemaIndex, SchemaTable };
export { collectCalls, parseSchema };
