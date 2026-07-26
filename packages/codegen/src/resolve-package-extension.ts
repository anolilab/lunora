/**
 * Runtime resolution of a schema extension defined inside a published package
 * (Plan 056). When `.extend(pkg.extension)`'s `defineSchemaExtension(...)` lives
 * in `node_modules` (only a `.d.ts` is reachable by AST), `discover-schema.ts`
 * falls back here: we find the import that bound the receiver, `require()` the
 * package from the project root, read the RUNTIME `SchemaExtension` value, and
 * convert its tables to bare {@link TableIR}s — the same IR the AST path
 * produces — for the caller to namespace + merge.
 *
 * Why runtime introspection (not `.d.ts`/`.mjs` parsing): the runtime extension
 * value already carries everything. `defineSchemaExtension(key, { tables })`
 * returns `{ key, tables }` verbatim; each table is a `defineTable(...)` builder
 * exposing its column `shape` (validators) and `.indexes`; and `@lunora/values`
 * validators are runtime-introspectable via `.kind` + `._meta` (the surface this
 * module mirrors — see `@lunora/values` `to-json-schema`).
 *
 * Best-effort + fail-safe: ANY failure (unresolved specifier, un-importable
 * module, not-a-`SchemaExtension` shape) returns `undefined`, and the caller
 * keeps its existing "skip with a warning" behaviour. Codegen never throws here.
 *
 * Sync by design: uses `require()` (Node ≥22.12 supports `require()` of ESM), so
 * the AST-based, synchronous `discoverSchema` need not become async.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

import type { ColumnMetaIR, IndexIR, TableIR, ValidatorIR, VectorIndexIR } from "./ir";

/** A runtime `@lunora/values` validator, duck-typed to the introspectable surface (`kind` + `_meta`). */
interface RuntimeValidator {
    _meta?: Record<string, unknown>;
    kind?: string;
}

/** A runtime `defineTable(...)` builder, duck-typed to the fields the IR needs. */
interface RuntimeTableBuilder {
    indexes?: ReadonlyArray<{ fields: ReadonlyArray<string>; name: string; unique?: boolean }>;
    isExternallyManaged?: boolean;
    // Carried only to detect (and warn about) features the runtime path does not
    // yet convert — see the drop-warning in `runtimeTableToIR`.
    rankIndexes?: ReadonlyArray<unknown>;
    relationMap?: Record<string, unknown>;
    searchIndexes?: ReadonlyArray<{ field: string; filterFields?: ReadonlyArray<string>; name: string; staged?: boolean }>;
    shape?: Record<string, RuntimeValidator>;
    shardMode?: { backend?: string; field?: string; kind: string };
    vectorIndexes?: ReadonlyArray<unknown>;
}

/** A runtime `defineSchemaExtension(...)` value, duck-typed. */
interface RuntimeSchemaExtension {
    key?: unknown;
    tables?: Record<string, RuntimeTableBuilder>;
    vectorIndexes?: Record<string, { dimensions?: number; field?: string; metadata?: ReadonlyArray<string>; metric?: VectorIndexIR["metric"]; table?: string }>;
}

/** The bare (un-namespaced) extension contents resolved from a package, ready for the caller to prefix + merge. */
interface ResolvedPackageExtension {
    bareTables: TableIR[];
    bareVectorIndexes: VectorIndexIR[];
    key: string;
}

/** The import binding behind a `.extend(...)` receiver: which module, which export, and the property path to the extension. */
interface ExtensionAccessPath {
    importedName: string;
    moduleSpecifier: string;
    propertyPath: ReadonlyArray<string>;
}

/** Render a runtime literal value as the source-text {@link ValidatorIR.literalValue} (matches the AST path's `v.literal(...)` text). */
const renderLiteralValue = (value: unknown): string | undefined => {
    switch (typeof value) {
        case "bigint": {
            return value.toString();
        }
        case "boolean":
        case "number": {
            return String(value);
        }
        case "string": {
            return JSON.stringify(value);
        }
        default: {
            return value === null ? "null" : undefined;
        }
    }
};

/** Map a runtime `_meta.column` bag to {@link ColumnMetaIR} (presence-only for function-valued modifiers). */
const columnMetaToIR = (column: Record<string, unknown> | undefined): ColumnMetaIR => {
    const hasDefault = column?.["defaultValue"] !== undefined || column?.["defaultFn"] !== undefined || column?.["serverDefault"] !== undefined;

    return {
        ...(hasDefault ? { hasDefault: true } : {}),
        ...(column?.["onUpdateFn"] === undefined ? {} : { hasOnUpdate: true }),
        notNull: (column?.["notNull"] as boolean | undefined) ?? true,
        ...(column?.["unique"] === true ? { unique: true } : {}),
    };
};

/**
 * Convert a runtime `@lunora/values` validator to a {@link ValidatorIR}, mirroring
 * the `validatorReader` in `@lunora/values` `to-json-schema` (children + metadata
 * live on `_meta`). Recurses for compound kinds. An absent/odd validator degrades
 * to `{ kind: "unknown" }` (emits `unknown`) rather than throwing.
 */
const runtimeValidatorToIR = (validator: RuntimeValidator | undefined): ValidatorIR => {
    const meta = validator?._meta ?? {};
    const kind = validator?.kind ?? "unknown";
    const ir: ValidatorIR = { column: columnMetaToIR(meta["column"] as Record<string, unknown> | undefined), kind };

    switch (kind) {
        case "array":
        case "optional": {
            ir.inner = runtimeValidatorToIR(meta["inner"] as RuntimeValidator | undefined);
            break;
        }
        case "id": {
            ir.tableName = meta["tableName"] as string | undefined;
            break;
        }
        case "literal": {
            ir.literalValue = renderLiteralValue(meta["value"]);
            break;
        }
        case "object": {
            const shape = (meta["shape"] as Record<string, RuntimeValidator> | undefined) ?? {};

            ir.shape = Object.fromEntries(Object.entries(shape).map(([name, child]) => [name, runtimeValidatorToIR(child)]));
            break;
        }
        case "record": {
            ir.valueType = runtimeValidatorToIR(meta["valueValidator"] as RuntimeValidator | undefined);

            if (meta["keyValidator"] !== undefined) {
                ir.keyType = runtimeValidatorToIR(meta["keyValidator"] as RuntimeValidator);
            }

            break;
        }
        case "storage": {
            // `v.storage("named-bucket")` carries its bucket on `_meta.bucket`; preserve
            // it so the generated `ctx.storage.bucket(name)` union stays accurate.
            if (typeof meta["bucket"] === "string") {
                ir.bucket = meta["bucket"];
            }

            break;
        }
        case "union": {
            const members = (meta["members"] as ReadonlyArray<RuntimeValidator> | undefined) ?? [];

            ir.members = members.map((member) => runtimeValidatorToIR(member));
            break;
        }
        default: {
            // Scalars (string/number/boolean/id-less) need only `kind`.
            break;
        }
    }

    return ir;
};

/** Map a runtime table builder's `shardMode` to the {@link TableIR} shape. */
// eslint-disable-next-line sonarjs/function-return-type -- the IR's `shardMode` is intentionally a `"global" | "root" | { … }` union.
const shardModeToIR = (shardMode: RuntimeTableBuilder["shardMode"]): TableIR["shardMode"] => {
    if (shardMode?.kind === "global") {
        return "global";
    }

    if (shardMode?.kind === "shardBy" && typeof shardMode.field === "string") {
        return { field: shardMode.field, kind: "shardBy" };
    }

    return "root";
};

/**
 * Features the runtime path does not yet convert. If a package extension's table
 * actually uses one, warn (matching the rest of this module's surface) rather
 * than drop it silently — silent loss would emit a wrong (e.g. relation-less)
 * type with no signal. The runtime builder exposes them, so we can detect use.
 */
const warnDroppedTableFeatures = (builder: RuntimeTableBuilder, bareName: string): void => {
    const dropped: string[] = [];

    if (builder.relationMap && Object.keys(builder.relationMap).length > 0) {
        dropped.push("relations");
    }

    if (builder.rankIndexes && builder.rankIndexes.length > 0) {
        dropped.push("rank indexes");
    }

    if (builder.vectorIndexes && builder.vectorIndexes.length > 0) {
        dropped.push("vector indexes");
    }

    if (dropped.length > 0) {
        // eslint-disable-next-line no-console -- make the limitation visible rather than silently emit an incomplete type.
        console.warn(
            `@lunora/codegen: package schema-extension table "${bareName}" declares ${dropped.join(" + ")}, which are not yet introspected from a node_modules extension — they will be absent from the generated types.`,
        );
    }
};

/** Convert one runtime table builder to a BARE-named {@link TableIR} (the caller applies the extension-key prefix). */
const runtimeTableToIR = (builder: RuntimeTableBuilder, bareName: string): TableIR => {
    const shape = builder.shape ?? {};
    const indexes: IndexIR[] = (builder.indexes ?? []).map((index) => {
        return { fields: index.fields, name: index.name, ...(index.unique ? { unique: true } : {}) };
    });

    warnDroppedTableFeatures(builder, bareName);

    return {
        ...(builder.isExternallyManaged ? { externallyManaged: true } : {}),
        geoIndexes: [],
        indexes,
        name: bareName,
        rankIndexes: [],
        relations: [],
        searchIndexes: (builder.searchIndexes ?? []).map((index) => {
            return {
                field: index.field,
                ...(index.filterFields ? { filterFields: index.filterFields } : {}),
                ...(index.staged === undefined ? {} : { staged: index.staged }),
                name: index.name,
            };
        }),
        shape: Object.fromEntries(Object.entries(shape).map(([name, validator]) => [name, runtimeValidatorToIR(validator)])),
        shardMode: shardModeToIR(builder.shardMode),
        // Inline vector/rank indexes and relations are not yet introspected from a
        // package extension; their presence is surfaced via `warnDroppedTableFeatures`.
        vectorIndexes: [],
    };
};

/** Convert a runtime `SchemaExtension` value to its bare tables + standalone vector indexes, or `undefined` if it isn't one. */
const resolvedExtensionToIR = (value: Record<string, unknown>): ResolvedPackageExtension | undefined => {
    const { key, tables } = value;

    if (typeof key !== "string" || typeof tables !== "object" || tables === null) {
        return undefined;
    }

    const bareTables = Object.entries(tables as Record<string, RuntimeTableBuilder>).map(([bareName, builder]) => runtimeTableToIR(builder, bareName));
    const vectorIndexes = (value["vectorIndexes"] ?? {}) as RuntimeSchemaExtension["vectorIndexes"];
    const bareVectorIndexes: VectorIndexIR[] = Object.entries(vectorIndexes ?? {}).map(([name, index]) => {
        return {
            ...(index.dimensions === undefined ? {} : { dimensions: index.dimensions }),
            ...(index.field === undefined ? {} : { field: index.field }),
            ...(index.metadata === undefined ? {} : { metadata: index.metadata }),
            ...(index.metric === undefined ? {} : { metric: index.metric }),
            name,
            table: index.table ?? "",
        };
    });

    return { bareTables, bareVectorIndexes, key };
};

/** The receiver identifier of a `.extend(arg)` argument: the whole identifier, or the object of `obj.prop`. */
const receiverIdentifierText = (argument: TsNode): string | undefined => {
    if (Node.isIdentifier(argument)) {
        return argument.getText();
    }

    if (Node.isPropertyAccessExpression(argument)) {
        const receiver = argument.getExpression();

        return Node.isIdentifier(receiver) ? receiver.getText() : undefined;
    }

    return undefined;
};

/**
 * Map a `.extend(arg)` argument to the import binding behind its receiver, by
 * scanning the source file's imports by LOCAL name (no type resolution, so a
 * `node_modules` target doesn't send us into a `.d.ts`). Handles the three import
 * shapes a package extension can arrive through:
 *
 * - named:     `import { plugin } from "x"; .extend(plugin.extension)` → export `plugin`, path `["extension"]`
 * - default:   `import plugin from "x"; .extend(plugin.extension)`     → export `default`, path `["extension"]`
 * - namespace: `import * as x from "x"; .extend(x.extension)`          → export `extension`, path `[]`
 *
 * (`.extend(ext)` with no property access works for named/default too.) Returns
 * `undefined` for any other shape — the caller falls back to warn+skip.
 */
const accessPathOf = (argument: TsNode): ExtensionAccessPath | undefined => {
    const receiverName = receiverIdentifierText(argument);

    if (receiverName === undefined) {
        return undefined;
    }

    const property = Node.isPropertyAccessExpression(argument) ? argument.getName() : undefined;
    const propertyPath = property === undefined ? [] : [property];

    for (const declaration of argument.getSourceFile().getImportDeclarations()) {
        const moduleSpecifier = declaration.getModuleSpecifierValue();

        for (const named of declaration.getNamedImports()) {
            const localName = named.getAliasNode()?.getText() ?? named.getName();

            if (localName === receiverName) {
                return { importedName: named.getName(), moduleSpecifier, propertyPath };
            }
        }

        if (declaration.getDefaultImport()?.getText() === receiverName) {
            return { importedName: "default", moduleSpecifier, propertyPath };
        }

        // `import * as ns` → the receiver IS the module namespace, so `ns.extension`'s
        // property is itself the export name (bare `.extend(ns)` is meaningless here).
        if (declaration.getNamespaceImport()?.getText() === receiverName && property !== undefined) {
            return { importedName: property, moduleSpecifier, propertyPath: [] };
        }
    }

    return undefined;
};

/** Walk `exportName` + `propertyPath` on an imported module namespace to the candidate extension value. */
const readExtensionValue = (module_: Record<string, unknown>, access: ExtensionAccessPath): unknown => {
    let current: unknown = module_[access.importedName];

    for (const segment of access.propertyPath) {
        if (typeof current !== "object" || current === null) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current;
};

/**
 * Resolve a `.extend(...)` argument that the AST path could not (its extension
 * lives in a published package) by importing the package from `projectRoot` and
 * introspecting the runtime `SchemaExtension`. Returns the bare extension
 * contents, or `undefined` on any failure (caller falls back to warn+skip).
 *
 * Only attempted when `projectRoot` is provided (the real codegen run); the
 * AST-only test callers pass none and keep the pure-AST behaviour.
 */
const resolvePackageExtension = (argument: TsNode, projectRoot: string): ResolvedPackageExtension | undefined => {
    const access = accessPathOf(argument);

    if (!access) {
        return undefined;
    }

    try {
        // Resolve + load the package from the PROJECT's node_modules (not codegen's).
        // `require()` of ESM is supported on the Node versions Lunora targets.
        const projectRequire = createRequire(join(projectRoot, "noop.cjs"));
        const resolved = projectRequire.resolve(access.moduleSpecifier);
        const loadedModule = projectRequire(resolved) as Record<string, unknown>;
        const value = readExtensionValue(loadedModule, access);

        if (typeof value !== "object" || value === null) {
            return undefined;
        }

        return resolvedExtensionToIR(value as Record<string, unknown>);
    } catch {
        // Unresolvable / un-importable / wrong shape — fail safe.
        return undefined;
    }
};

export type { ResolvedPackageExtension };
export { resolvePackageExtension, runtimeTableToIR, runtimeValidatorToIR };
