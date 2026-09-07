/**
 * ts-morph mutation core for the visual schema editor (plan 024). Pure
 * string-in / string-out over an in-memory ts-morph project — no I/O, no
 * codegen (Item 3 wires those). Extends `.vis/templates/_helpers/insert-table.ts`
 * (which only adds a table) to also add an **optional** column and an index,
 * all formatting-preserving.
 *
 * Safety boundary: only **additive** edits apply directly. {@link classifyEdit}
 * labels every request additive or destructive; destructive edits
 * (rename/drop/type-change/required) change the DO's persisted SQLite shape and
 * MUST route through the migrations handoff — {@link applyAdditiveEdit} refuses
 * them.
 */
import type { CallExpression, Node, ObjectLiteralExpression, PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

import { collectCalls } from "./parse";

/**
 * A JS identifier, so a table/column/index name lands in the generated source as
 * a bare property/string key and can't break out to inject arbitrary text.
 * Mirrors the sibling RLS scaffolder's `IDENTIFIER_PATTERN`
 * ({@link ./policy-scaffold}); kept in lockstep deliberately.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/u;

/**
 * The `v.*` validator constructors the schema editor may emit. The visual editor
 * only ever sends this fixed palette, but the endpoint is CSRF-reachable, so the
 * allow-list is enforced server-side rather than trusted from the client. Mirror
 * of the `v` surface exported by `@lunora/values`.
 */
const VALIDATOR_METHODS = new Set([
    "any",
    "array",
    "bigint",
    "boolean",
    "bytes",
    "date",
    "id",
    "literal",
    "null",
    "number",
    "object",
    "optional",
    "record",
    "storage",
    "string",
    "timestamp",
    "union",
]);

/**
 * True when `node` is a side-effect-free `v.*` validator expression — a call on
 * `v.<method>` (method in {@link VALIDATOR_METHODS}) whose arguments are
 * themselves validator expressions or safe literals (string/number/boolean/null,
 * object literals of validators, arrays of validators). Anything else — a bare
 * identifier, a `require(...)`/`fetch(...)` call, a comma/assignment expression,
 * a template literal, a member access off something other than `v` — is rejected.
 * This is what stops attacker-controlled `validator` text (e.g.
 * `(globalThis.x=require('child_process').execSync('id'),v.string())`) from
 * reaching the generated `schema.ts`.
 */
const isValidatorExpression = (node: Node): boolean => {
    // Unwrap `(...)` so an outer parenthesised expression (e.g. our `(${validator})`
    // wrapper, or `v.optional((v.string())))`) is checked by its inner expression.
    if (node.getKind() === SyntaxKind.ParenthesizedExpression) {
        return isValidatorExpression(node.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression());
    }

    if (node.getKind() !== SyntaxKind.CallExpression) {
        return false;
    }

    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();

    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) {
        return false;
    }

    const access = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);

    // The receiver must be the bare `v` identifier — not `v.x.y`, not `foo.v`.
    if (access.getExpression().getKind() !== SyntaxKind.Identifier || access.getExpression().getText() !== "v" || !VALIDATOR_METHODS.has(access.getName())) {
        return false;
    }

    // `isValidatorExpression` and `isValidatorArgument` are mutually recursive
    // (a validator's arguments may themselves be validators), so one must
    // reference the other before its definition — unavoidable here.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion
    return call.getArguments().every((argument) => isValidatorArgument(argument));
};

/** True when an argument to a `v.*` call is a safe validator expression, literal, object-of-validators, or array-of-validators. */
const isValidatorArgument = (node: Node): boolean => {
    const kind = node.getKind();

    if (kind === SyntaxKind.ParenthesizedExpression) {
        return isValidatorArgument(node.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression());
    }

    // Safe primitive literals: string / number / boolean / null. (Unary `-1` is
    // a PrefixUnaryExpression over a numeric literal — allow it for `v.literal`.)
    if (
        kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.NumericLiteral ||
        kind === SyntaxKind.TrueKeyword ||
        kind === SyntaxKind.FalseKeyword ||
        kind === SyntaxKind.NullKeyword
    ) {
        return true;
    }

    if (kind === SyntaxKind.PrefixUnaryExpression) {
        const unary = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);

        return unary.getOperand().getKind() === SyntaxKind.NumericLiteral;
    }

    // `v.object({ a: v.string() })` — every property value must itself validate.
    if (kind === SyntaxKind.ObjectLiteralExpression) {
        return node
            .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
            .getProperties()
            .every((property) => {
                if (property.getKind() !== SyntaxKind.PropertyAssignment) {
                    return false;
                }

                const initializer = (property as PropertyAssignment).getInitializer();

                return initializer !== undefined && isValidatorArgument(initializer);
            });
    }

    // `v.array([...])` / `v.union([...])` argument shapes that pass an array.
    if (kind === SyntaxKind.ArrayLiteralExpression) {
        return node
            .asKindOrThrow(SyntaxKind.ArrayLiteralExpression)
            .getElements()
            .every((element) => isValidatorArgument(element));
    }

    // Otherwise it must be a nested `v.*` validator call.
    return isValidatorExpression(node);
};

/**
 * Parse `validator` (the inner expression text, e.g. `v.string()`) and confirm it
 * is a single side-effect-free `v.*` validator expression. Returns `true` only
 * for a well-formed, allow-listed validator; everything else is rejected. The
 * editor's POST body is attacker-influenced (the endpoint is CSRF-reachable), so
 * raw validator text is never interpolated into source without this check.
 */
const isAllowedValidatorText = (validator: unknown): boolean => {
    if (typeof validator !== "string" || validator.trim().length === 0) {
        return false;
    }

    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("validator.ts", `const __v = (${validator});`, { overwrite: true });

    // SYNTACTIC diagnostics only — `v` is undefined in this isolated file, so a
    // semantic ("Cannot find name 'v'") check would reject every validator. Parse
    // errors (unbalanced parens, stray tokens) are fatal.
    if (project.getProgram().getSyntacticDiagnostics(sourceFile).length > 0) {
        return false;
    }

    // Reject anything beyond the single `const __v = (...)` we wrote — a smuggled
    // second statement (e.g. `v.string()); doSomething(); (v.string()`) must not
    // slip through on the structural check below.
    if (sourceFile.getStatements().length !== 1) {
        return false;
    }

    const declaration = sourceFile.getVariableDeclaration("__v");
    const initializer = declaration?.getInitializer();

    // `isValidatorExpression` unwraps the `(...)` wrapper; if the initializer is
    // missing or isn't a lone `v.*` validator call, reject.
    return initializer !== undefined && isValidatorExpression(initializer);
};

/** Storage backends `.global()` accepts. A closed union, so it is never free text. */
type GlobalBackend = "d1" | "hyperdrive";

/** Add a new table to `defineSchema({ ... })`. */
interface AddTableEdit {
    /**
     * Mark the table `.global()`. Pass `{}` for the D1 default, or a backend for
     * an external store — `lunora introspect` uses `{ backend: "hyperdrive" }`
     * because the rows live in the database it read.
     */
    readonly global?: { readonly backend?: GlobalBackend };
    readonly kind: "addTable";
    readonly table: string;
}

/** Add an `v.optional(...)` column to an existing table. */
interface AddOptionalColumnEdit {
    readonly column: string;
    readonly kind: "addOptionalColumn";
    readonly table: string;

    /**
     * Inner validator expression text WITHOUT the `v.optional(...)` wrapper, e.g.
     * `v.string()`. Always wrapped in `v.optional(...)` on apply, because only
     * optional columns are additive-safe (a required column needs a backfill
     * migration).
     */
    readonly validator: string;
}

/** Add a secondary index to an existing table. */
interface AddIndexEdit {
    readonly fields: ReadonlyArray<string>;
    readonly kind: "addIndex";
    readonly name: string;
    readonly table: string;
    readonly unique?: boolean;
}

/** Additive edits — the only requests {@link applyAdditiveEdit} applies. */
type AdditiveEdit = AddIndexEdit | AddOptionalColumnEdit | AddTableEdit;

/**
 * Destructive edits — never applied directly; routed to the migration handoff
 * (plan 024 Item 5). Carried as data so the editor can describe the request.
 */
interface DestructiveEdit {
    readonly column?: string;
    readonly kind: "changeColumnType" | "dropColumn" | "dropTable" | "makeRequired" | "renameColumn";
    readonly newName?: string;
    readonly table: string;
    readonly validator?: string;
}

/** Any edit the editor can request. */
type SchemaEdit = AdditiveEdit | DestructiveEdit;

const ADDITIVE_KINDS = new Set<SchemaEdit["kind"]>(["addIndex", "addOptionalColumn", "addTable"]);

/** Accepted `.global({ backend })` values, enforced server-side like {@link VALIDATOR_METHODS}. */
const GLOBAL_BACKENDS = new Set<GlobalBackend>(["d1", "hyperdrive"]);

/**
 * Classify an edit request. Additive edits ({@link AdditiveEdit}) apply
 * directly; everything else changes stored data and is destructive.
 */
const classifyEdit = (edit: SchemaEdit): "additive" | "destructive" => (ADDITIVE_KINDS.has(edit.kind) ? "additive" : "destructive");

/** Failure reasons an additive edit can report. */
type ApplyFailureReason =
    | "aliased-define-schema"
    | "destructive"
    | "duplicate-column"
    | "duplicate-index"
    | "duplicate-table"
    | "invalid-identifier"
    | "invalid-validator"
    | "no-define-schema"
    | "non-object-argument"
    | "unknown-table";

/** True for a bare JS identifier safe to emit as a property/string key. Guards `typeof` first — `RegExp.test` coerces non-strings. */
const isIdentifier = (value: unknown): value is string => typeof value === "string" && IDENTIFIER_PATTERN.test(value);

/**
 * Validate an additive edit's interpolated strings before any source is
 * generated. Table/column/index names must be bare identifiers and the
 * `validator` text must be an allow-listed `v.*` expression — the endpoint is
 * CSRF-reachable, so the POST body is treated as attacker-influenced. Returns a
 * failure reason for the first violation, or `undefined` when the edit is safe.
 */
const validateAdditiveEdit = (edit: AdditiveEdit): ApplyFailureReason | undefined => {
    if (!isIdentifier(edit.table)) {
        return "invalid-identifier";
    }

    if (edit.kind === "addTable" && edit.global?.backend !== undefined && !GLOBAL_BACKENDS.has(edit.global.backend)) {
        return "invalid-identifier";
    }

    if (edit.kind === "addOptionalColumn") {
        if (!isIdentifier(edit.column)) {
            return "invalid-identifier";
        }

        if (!isAllowedValidatorText(edit.validator)) {
            return "invalid-validator";
        }
    }

    if (edit.kind === "addIndex") {
        if (!isIdentifier(edit.name)) {
            return "invalid-identifier";
        }

        if (!Array.isArray(edit.fields) || !edit.fields.every((field) => isIdentifier(field))) {
            return "invalid-identifier";
        }
    }

    return undefined;
};

/** Tagged result of applying an additive edit. */
type ApplyEditResult = { ok: false; reason: ApplyFailureReason } | { ok: true; text: string };

/** Find the `defineSchema({ ... })` tables object literal, or a failure reason. */
const findTablesObject = (
    source: string,
):
    | { object: ObjectLiteralExpression; sourceFile: ReturnType<Project["createSourceFile"]> }
    | { reason: Exclude<ApplyFailureReason, "destructive" | "duplicate-column" | "duplicate-index" | "duplicate-table" | "unknown-table"> } => {
    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    let defineSchemaCall: CallExpression | undefined;

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getText() === "defineSchema") {
            defineSchemaCall = call;
            break;
        }
    }

    if (defineSchemaCall === undefined) {
        const aliased = sourceFile
            .getImportDeclarations()
            .some((declaration) => declaration.getNamedImports().some((named) => named.getName() === "defineSchema" && named.getAliasNode() !== undefined));

        return { reason: aliased ? "aliased-define-schema" : "no-define-schema" };
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        return { reason: "non-object-argument" };
    }

    return { object: tablesArgument.asKindOrThrow(SyntaxKind.ObjectLiteralExpression), sourceFile };
};

/** Look up a table's property assignment in the tables object, if present. */
const findTableProperty = (tablesObject: ObjectLiteralExpression, table: string): PropertyAssignment | undefined => {
    for (const property of tablesObject.getProperties()) {
        if (
            property.getKind() === SyntaxKind.PropertyAssignment &&
            (property as PropertyAssignment).getNameNode().getText().replaceAll(/["']/gu, "") === table
        ) {
            return property as PropertyAssignment;
        }
    }

    return undefined;
};

/** The innermost `defineTable({ ... })` shape object for a table property. */
const findDefineTableShape = (tableProperty: PropertyAssignment): ObjectLiteralExpression | undefined => {
    const initializer = tableProperty.getInitializer();
    const defineTableCall = initializer === undefined ? undefined : collectCalls(initializer).find((call) => call.getExpression().getText() === "defineTable");
    const shape = defineTableCall?.getArguments()[0];

    return shape?.getKind() === SyntaxKind.ObjectLiteralExpression ? shape.asKindOrThrow(SyntaxKind.ObjectLiteralExpression) : undefined;
};

const applyAddTable = (tablesObject: ObjectLiteralExpression, edit: AddTableEdit): ApplyFailureReason | undefined => {
    if (findTableProperty(tablesObject, edit.table) !== undefined) {
        return "duplicate-table";
    }

    // `backend` is a closed union validated upstream, so this interpolation cannot
    // carry arbitrary text.
    const backend = edit.global?.backend;
    const backendArgument = backend === undefined ? "" : `{ backend: ${JSON.stringify(backend)} }`;
    const globalCall = edit.global === undefined ? "" : `.global(${backendArgument})`;

    tablesObject.addPropertyAssignment({
        initializer: `defineTable({
        // Add your column validators here.
        // Example:
        // text: v.string(),
        // createdAt: v.number(),
    })${globalCall}`,
        name: edit.table,
    });

    return undefined;
};

const applyAddOptionalColumn = (tablesObject: ObjectLiteralExpression, edit: AddOptionalColumnEdit): ApplyFailureReason | undefined => {
    const tableProperty = findTableProperty(tablesObject, edit.table);

    if (tableProperty === undefined) {
        return "unknown-table";
    }

    const shape = findDefineTableShape(tableProperty);

    if (shape === undefined) {
        return "unknown-table";
    }

    const exists = shape
        .getProperties()
        .some(
            (property) =>
                property.getKind() === SyntaxKind.PropertyAssignment &&
                (property as PropertyAssignment).getNameNode().getText().replaceAll(/["']/gu, "") === edit.column,
        );

    if (exists) {
        return "duplicate-column";
    }

    // Always wrap in `v.optional(...)`: only optional columns are additive-safe.
    shape.addPropertyAssignment({ initializer: `v.optional(${edit.validator})`, name: edit.column });

    return undefined;
};

const applyAddIndex = (tableProperty: PropertyAssignment | undefined, edit: AddIndexEdit): ApplyFailureReason | undefined => {
    if (tableProperty === undefined) {
        return "unknown-table";
    }

    const initializer = tableProperty.getInitializer();

    if (initializer === undefined) {
        return "unknown-table";
    }

    const duplicate = collectCalls(initializer).some((call) => {
        const expression = call.getExpression();

        if (expression.getKind() !== SyntaxKind.PropertyAccessExpression) {
            return false;
        }

        const access = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const [nameArgument] = call.getArguments();

        return (
            access.getName() === "index" &&
            nameArgument?.getKind() === SyntaxKind.StringLiteral &&
            nameArgument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText() === edit.name
        );
    });

    if (duplicate) {
        return "duplicate-index";
    }

    const fields = edit.fields.map((field) => JSON.stringify(field)).join(", ");
    const options = edit.unique === true ? ", { unique: true }" : "";

    // Append `.index("name", [fields]{, options})` to the existing chain.
    tableProperty.setInitializer(`${initializer.getText()}.index(${JSON.stringify(edit.name)}, [${fields}]${options})`);

    return undefined;
};

/**
 * Apply an **additive** edit to a schema source string, preserving formatting.
 * Destructive edits are refused with `{ ok: false, reason: "destructive" }`;
 * route them through the migration handoff (plan 024 Item 5).
 */
const applyAdditiveEdit = (source: string, edit: SchemaEdit): ApplyEditResult => {
    if (classifyEdit(edit) === "destructive") {
        return { ok: false, reason: "destructive" };
    }

    const additive = edit as AdditiveEdit;

    // Validate every interpolated string BEFORE generating source. The endpoint
    // is CSRF-reachable, so names and validator text are attacker-influenced.
    const invalid = validateAdditiveEdit(additive);

    if (invalid !== undefined) {
        return { ok: false, reason: invalid };
    }

    const located = findTablesObject(source);

    if ("reason" in located) {
        return { ok: false, reason: located.reason };
    }

    const { object: tablesObject, sourceFile } = located;

    let failure: ApplyFailureReason | undefined;

    if (additive.kind === "addTable") {
        failure = applyAddTable(tablesObject, additive);
    } else if (additive.kind === "addOptionalColumn") {
        failure = applyAddOptionalColumn(tablesObject, additive);
    } else {
        failure = applyAddIndex(findTableProperty(tablesObject, additive.table), additive);
    }

    if (failure !== undefined) {
        return { ok: false, reason: failure };
    }

    return { ok: true, text: sourceFile.getFullText() };
};

export type {
    AddIndexEdit,
    AdditiveEdit,
    AddOptionalColumnEdit,
    AddTableEdit,
    ApplyEditResult,
    ApplyFailureReason,
    DestructiveEdit,
    GlobalBackend,
    SchemaEdit,
};
export { applyAdditiveEdit, classifyEdit };
