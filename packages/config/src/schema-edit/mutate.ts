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
import type { CallExpression, ObjectLiteralExpression, PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

import { collectCalls } from "./parse";

/** Add a new table to `defineSchema({ ... })`. */
interface AddTableEdit {
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
    | "no-define-schema"
    | "non-object-argument"
    | "unknown-table";

/** Tagged result of applying an additive edit. */
type ApplyEditResult = { ok: false; reason: ApplyFailureReason } | { ok: true; text: string };

/** Find the `defineSchema({ ... })` tables object literal, or a failure reason. */
const findTablesObject = (
    source: string,
): { object: ObjectLiteralExpression; sourceFile: ReturnType<Project["createSourceFile"]> } | { reason: Exclude<ApplyFailureReason, "destructive" | "duplicate-column" | "duplicate-index" | "duplicate-table" | "unknown-table"> } => {
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
        const aliased = sourceFile.getImportDeclarations().some((declaration) =>
            declaration.getNamedImports().some((named) => named.getName() === "defineSchema" && named.getAliasNode() !== undefined),
        );

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
        if (property.getKind() === SyntaxKind.PropertyAssignment && (property as PropertyAssignment).getNameNode().getText().replaceAll(/["']/gu, "") === table) {
            return property as PropertyAssignment;
        }
    }

    return undefined;
};

/** The innermost `defineTable({ ... })` shape object for a table property. */
const findDefineTableShape = (tableProperty: PropertyAssignment): ObjectLiteralExpression | undefined => {
    const defineTableCall = tableProperty
        .getInitializer()
        ?.getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((call) => call.getExpression().getText() === "defineTable");
    const shape = defineTableCall?.getArguments()[0];

    return shape?.getKind() === SyntaxKind.ObjectLiteralExpression ? shape.asKindOrThrow(SyntaxKind.ObjectLiteralExpression) : undefined;
};

const applyAddTable = (tablesObject: ObjectLiteralExpression, edit: AddTableEdit): ApplyFailureReason | undefined => {
    if (findTableProperty(tablesObject, edit.table) !== undefined) {
        return "duplicate-table";
    }

    tablesObject.addPropertyAssignment({
        initializer: `defineTable({
        // Add your column validators here.
        // Example:
        // text: v.string(),
        // createdAt: v.number(),
    })`,
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

    const exists = shape.getProperties().some((property) => property.getKind() === SyntaxKind.PropertyAssignment && (property as PropertyAssignment).getNameNode().getText().replaceAll(/["']/gu, "") === edit.column);

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

        return access.getName() === "index" && nameArgument?.getKind() === SyntaxKind.StringLiteral && nameArgument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText() === edit.name;
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

    const located = findTablesObject(source);

    if ("reason" in located) {
        return { ok: false, reason: located.reason };
    }

    const { object: tablesObject, sourceFile } = located;
    const additive = edit as AdditiveEdit;

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

export type { AddIndexEdit, AdditiveEdit, AddOptionalColumnEdit, AddTableEdit, ApplyEditResult, ApplyFailureReason, DestructiveEdit, SchemaEdit };
export { applyAdditiveEdit, classifyEdit };
