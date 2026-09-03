import type { CallExpression, Expression, Node as TsNode, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import { diagnosticAt } from "../../../diagnostics";
import type { TableIR, VectorIndexIR } from "../../../ir";
import { resolvePackageExtension } from "../../../resolve-package-extension";
import { asMetric, getNumberProperty, getStringProperty, objectPropertyInitializer } from "./properties";
import { assertTableNameAllowed, parseTableBuilder } from "./table-builder";

/** Read the `source.table` literal off a `defineVectorIndex({ source: { table } })` options object. */
const sourceTableOf = (optionsExpression: ObjectLiteralExpression): string => {
    const sourceProperty = optionsExpression.getProperty("source");

    if (sourceProperty && Node.isPropertyAssignment(sourceProperty)) {
        const sourceInitializer = sourceProperty.getInitializer();

        if (sourceInitializer && Node.isObjectLiteralExpression(sourceInitializer)) {
            return getStringProperty(sourceInitializer, "table") ?? "_unknown_";
        }
    }

    return "_unknown_";
};

/** Lift one `name: defineVectorIndex({...})` property into a {@link VectorIndexIR}, or `undefined`. */
const standaloneVectorIndexFromProperty = (property: Node): VectorIndexIR | undefined => {
    if (!Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const callee = initializer.getExpression();

    if (!Node.isIdentifier(callee) || callee.getText() !== "defineVectorIndex") {
        return undefined;
    }

    const optionsExpression = initializer.getArguments()[0];

    if (!optionsExpression || !Node.isObjectLiteralExpression(optionsExpression)) {
        return undefined;
    }

    const nameNode = property.getNameNode();
    const indexName = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();

    return {
        dimensions: getNumberProperty(optionsExpression, "dimensions"),
        metric: asMetric(getStringProperty(optionsExpression, "metric")),
        name: indexName,
        table: sourceTableOf(optionsExpression),
    };
};

/**
 * Parse the optional second argument to `defineSchema(...)` — a map of index
 * name -> `defineVectorIndex({...})` call (DSL Shape B). The embedded text
 * source is a `select` function, so `field`/`metadata` stay undefined here.
 */
const parseStandaloneVectorIndexes = (object: ObjectLiteralExpression): VectorIndexIR[] => {
    const result: VectorIndexIR[] = [];

    for (const property of object.getProperties()) {
        const index = standaloneVectorIndexFromProperty(property);

        if (index) {
            result.push(index);
        }
    }

    return result;
};

/**
 * Apply the extension `key` prefix to a bare table name. Mirrors the runtime
 * `prefixTableName` in `@lunora/server`'s `plugin.ts` so generated names match.
 */
const prefixTableName = (key: string, bareName: string): string => `${key}_${bareName}`;

/** Same shape as `assertTableNameAllowed`'s identifier gate — the key is a prefix of a table name. */
const EXTENSION_KEY_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * Reject an extension key that cannot survive {@link prefixTableName}.
 *
 * The key is concatenated into every table the extension contributes, so its
 * characters land in generated type names (`Doc_<name>`) and unquoted property
 * keys exactly as a table name's do. Nothing checked it: `defineSchemaExtension("rate-limit", …)`
 * discovered cleanly and then died in `emit.ts` with an unlocated `INTERNAL`
 * naming `rate-limit_buckets` — a table the user never typed, with no file, no
 * line and no mention of the call that composed it. Validating the KEY reports
 * what the user actually wrote, where they wrote it.
 * @param key the `defineSchemaExtension` key.
 * @param node the node to point the diagnostic at (the key literal, or the `.extend(...)` argument for a package extension).
 * @throws when the key is not a valid JS identifier.
 */
const assertExtensionKeyAllowed = (key: string, node: TsNode): void => {
    if (EXTENSION_KEY_IDENTIFIER_RE.test(key)) {
        return;
    }

    throw diagnosticAt(
        node,
        `defineSchemaExtension key ${JSON.stringify(key)} is not a valid JS identifier — it is prefixed onto every table the extension contributes (\`${key}_<table>\`), and table names are used in generated type names (Doc_<name>) and must match [A-Za-z_$][A-Za-z0-9_$]*. Rename the extension key.`,
    );
};

/**
 * Rewrite a single intra-extension table reference to its prefixed name. A
 * reference is "intra-extension" only when its target is one of the extension's
 * own bare table names; references to base/app tables are returned untouched.
 * Mirrors the runtime `rewriteReference`.
 */
const rewriteReference = (target: string, key: string, bareNames: ReadonlySet<string>): string =>
    bareNames.has(target) ? prefixTableName(key, target) : target;

/**
 * Apply the runtime namespacing transform to one parsed extension table:
 * prefix the table's own name, rewrite relation targets, and rewrite inline
 * vector-index `table` references. The inline-vectorize parser stamps the
 * owning (bare) table name onto each `vectorIndexes[].table`, which is always
 * an intra-extension reference, so it always resolves to the prefixed owner.
 *
 * Rank indexes (`table.rankIndexes`) are captured in the IR but carry no
 * cross-table reference — a rank index's owner is always the table it is
 * declared on, which is `ownPrefixed`. So the `...table` spread carries them
 * onto the prefixed table verbatim; there is nothing extra to rewrite, and the
 * emitted `RankIndexNamesByTable` keys them under the prefixed name for free.
 *
 * Aggregate indexes are not represented in the codegen IR (the table builder
 * walk doesn't capture them) and have no name consumer in the generated query
 * API (they resolve by `{op, field?, where?}`), so there is nothing to rewrite
 * here — unlike the runtime, which additionally rewrites their `on` fields.
 */
const namespaceExtensionTable = (table: TableIR, key: string, bareNames: ReadonlySet<string>): TableIR => {
    const ownPrefixed = prefixTableName(key, table.name);

    return {
        ...table,
        // Provenance for the generated `AppTableName` union — this table came from
        // an add-on, not from the app's own `defineSchema`.
        extensionKey: key,
        name: ownPrefixed,
        relations: table.relations.map((relation) => {
            return { ...relation, table: rewriteReference(relation.table, key, bareNames) };
        }),
        // Inline `.vectorize()` stamps `table` with the bare owner name, so it
        // is always one of `bareNames` and resolves to `ownPrefixed`.
        vectorIndexes: table.vectorIndexes.map((index) => {
            return { ...index, table: rewriteReference(index.table, key, bareNames) };
        }),
    };
};

/** The initializer expression a resolved declaration carries, or `undefined` for a declaration we don't follow. */
const declarationInitializer = (declaration: TsNode): Expression | undefined => {
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        return declaration.getInitializer();
    }

    if (Node.isShorthandPropertyAssignment(declaration)) {
        return declaration.getNameNode();
    }

    return undefined;
};

/** True when `argument` is a direct inline `defineSchemaExtension("k", {...})` call. */
const isInlineExtensionCall = (argument: TsNode): argument is CallExpression => {
    if (!Node.isCallExpression(argument)) {
        return false;
    }

    const callee = argument.getExpression();

    return Node.isIdentifier(callee) && callee.getText() === "defineSchemaExtension";
};

/**
 * The identifier to resolve for an identifier / property-access `.extend(...)`
 * argument, or `undefined`. For `.extend(plugin.extension)` we resolve the
 * RECEIVER (`plugin`), NOT the `.extension` name: a `definePlugin(...)` /
 * `defineSchemaExtension(...)` value has a return TYPE (declared in
 * `@lunora/server`) whose `extension` field would send symbol-resolution into
 * that package's `.d.ts`, losing the local object literal. Following the receiver
 * keeps us on the project's own `const plugin = definePlugin(...)` declaration,
 * which we then navigate structurally in {@link nextExpressionFromDeclaration}.
 */
const extensionTargetIdentifier = (argument: TsNode): TsNode | undefined => {
    if (Node.isIdentifier(argument)) {
        return argument;
    }

    if (Node.isPropertyAccessExpression(argument)) {
        const receiver = argument.getExpression();

        return Node.isIdentifier(receiver) ? receiver : undefined;
    }

    return undefined;
};

/**
 * The object literal a plugin/extension value exposes its properties on: the
 * literal itself (`const p = { extension: … }`), or the config object passed to a
 * `definePlugin("key", { extension: … })` wrapper (the shape the registry's
 * `ratelimit`/`presence` items ship). Returns `undefined` for anything else.
 */
const pluginConfigObject = (expression: Expression): ObjectLiteralExpression | undefined => {
    if (Node.isObjectLiteralExpression(expression)) {
        return expression;
    }

    if (Node.isCallExpression(expression)) {
        const callee = expression.getExpression();
        let name: string | undefined;

        if (Node.isIdentifier(callee)) {
            name = callee.getText();
        } else if (Node.isPropertyAccessExpression(callee)) {
            name = callee.getName();
        }

        if (name === "definePlugin") {
            const configArgument = expression.getArguments()[1];

            return configArgument && Node.isObjectLiteralExpression(configArgument) ? configArgument : undefined;
        }
    }

    return undefined;
};

/**
 * Resolve a `.extend(...)` argument expression to the `defineSchemaExtension`
 * call it ultimately denotes. Handles the inline call, a same-project
 * identifier (`.extend(myExt)`), and a property access (`.extend(plugin.extension)`)
 * by following symbols to their declarations. Returns `undefined` when the
 * argument resolves into another package (only a `.d.ts` / `node_modules`
 * declaration is reachable) or cannot be resolved locally.
 */

/**
 * Given a declaration the `.extend(...)` argument's symbol points at, return the
 * next expression to keep resolving toward the `defineSchemaExtension(...)` call:
 * the object's named property for `.extend(plugin.extension)`, or the
 * declaration's own initializer for `.extend(myExt)`. Returns `undefined` when
 * the declaration carries nothing further to follow.
 */
const nextExpressionFromDeclaration = (declaration: TsNode, argument: TsNode): Expression | undefined => {
    // `const myExt = defineSchemaExtension(...)`,
    // `const plugin = { extension: defineSchemaExtension(...) }`, or
    // `const plugin = definePlugin("key", { extension: defineSchemaExtension(...) })`.
    const initializer = declarationInitializer(declaration);

    if (!initializer) {
        return undefined;
    }

    // For `.extend(plugin.extension)`, dig the named property off the plugin's
    // config object — unwrapping a `definePlugin(...)` wrapper when present.
    if (Node.isPropertyAccessExpression(argument)) {
        const configObject = pluginConfigObject(initializer);

        return configObject ? objectPropertyInitializer(configObject, argument.getName()) : undefined;
    }

    return initializer;
};

const resolveSchemaExtensionCall = (argument: TsNode): CallExpression | undefined => {
    let current: TsNode | undefined = argument;
    // Bound the symbol-follow loop so a pathological `const a = b; const b = a;`
    // cycle can't spin forever.
    let hops = 0;

    while (current && hops < 32) {
        hops += 1;

        // Inline: `.extend(defineSchemaExtension("k", {...}))`.
        if (isInlineExtensionCall(current)) {
            return current;
        }

        const target = extensionTargetIdentifier(current);
        const symbol = target && Node.isIdentifier(target) ? target.getSymbol() : undefined;
        const declarations = symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? [];
        const first = declarations[0];

        if (!first) {
            return undefined;
        }

        const declarationFile = first.getSourceFile();

        // Cross-package: only a `.d.ts` or a `node_modules` source is reachable.
        // We cannot read the real `defineSchemaExtension(...)` literal, so defer.
        if (declarationFile.isInNodeModules() || declarationFile.isDeclarationFile()) {
            return undefined;
        }

        current = nextExpressionFromDeclaration(first, current);
    }

    return undefined;
};

/** Read the `{ tables: {...}, vectorIndexes?: {...} }` options object off a `defineSchemaExtension(key, options)` call, with the key's node for diagnostics. */
const extensionPartsOf = (call: CallExpression): { key: string; keyNode: TsNode; options: ObjectLiteralExpression } | undefined => {
    const [keyArgument, optionsArgument] = call.getArguments();

    if (!keyArgument || !Node.isStringLiteral(keyArgument)) {
        return undefined;
    }

    if (!optionsArgument || !Node.isObjectLiteralExpression(optionsArgument)) {
        return undefined;
    }

    return { key: keyArgument.getLiteralText(), keyNode: keyArgument, options: optionsArgument };
};

/** Parse the `tables: {...}` property of a `defineSchemaExtension` options object into bare-named {@link TableIR}s. */
const parseExtensionTables = (options: ObjectLiteralExpression): TableIR[] => {
    const tablesProperty = options.getProperty("tables");

    if (!tablesProperty || !Node.isPropertyAssignment(tablesProperty)) {
        return [];
    }

    const tablesObject = tablesProperty.getInitializer();

    if (!tablesObject || !Node.isObjectLiteralExpression(tablesObject)) {
        return [];
    }

    const tables: TableIR[] = [];

    for (const property of tablesObject.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer) {
            continue;
        }

        const name = property.getName();

        // Validate the extension's BARE name — the user wrote this one; the
        // eventual `${key}_${bareName}` prefix is codegen's own construction,
        // so an error about the prefixed name would point at something the
        // user never typed.
        assertTableNameAllowed(name, property.getNameNode());
        tables.push(parseTableBuilder(initializer, name));
    }

    return tables;
};

/** Parse the optional `vectorIndexes: {...}` property of a `defineSchemaExtension` options object (Shape B map). */
const parseExtensionVectorIndexes = (options: ObjectLiteralExpression): VectorIndexIR[] => {
    const property = options.getProperty("vectorIndexes");

    if (!property || !Node.isPropertyAssignment(property)) {
        return [];
    }

    const object = property.getInitializer();

    if (!object || !Node.isObjectLiteralExpression(object)) {
        return [];
    }

    return parseStandaloneVectorIndexes(object);
};

/** Result of merging one `.extend(...)` extension: prefixed tables + prefixed standalone vector indexes. */
interface MergedExtension {
    tables: TableIR[];
    vectorIndexes: VectorIndexIR[];
}

/**
 * Apply runtime namespacing (table prefixing + intra-extension reference
 * rewrite) to an extension's BARE tables + standalone vector indexes — the step
 * shared by the AST path and the package-runtime path ({@link resolvePackageExtension}).
 */
const namespaceExtension = (
    key: string,
    bareTables: ReadonlyArray<TableIR>,
    bareVectorIndexes: ReadonlyArray<VectorIndexIR>,
    node: TsNode,
): MergedExtension => {
    // Both paths reach the prefixing through here, which is why the validation
    // lives here: the AST path checked an extension's bare table names and never
    // its key, and the package-runtime path (`resolvePackageExtension`) checked
    // neither. Everything unchecked ended up spliced into a generated identifier.
    assertExtensionKeyAllowed(key, node);

    for (const table of bareTables) {
        assertTableNameAllowed(table.name, node);
    }

    const bareNames = new Set(bareTables.map((table) => table.name));
    const tables = bareTables.map((table) => namespaceExtensionTable(table, key, bareNames));

    // Standalone vector indexes carry their own bare map key plus a `table`
    // reference; prefix both, matching the runtime merge.
    const vectorIndexes = bareVectorIndexes.map((index) => {
        return { ...index, name: prefixTableName(key, index.name), table: rewriteReference(index.table, key, bareNames) };
    });

    return { tables, vectorIndexes };
};

/** Apply runtime namespacing to one AST-resolved `defineSchemaExtension(...)` options object. */
const mergeExtension = (key: string, keyNode: TsNode, options: ObjectLiteralExpression): MergedExtension =>
    namespaceExtension(key, parseExtensionTables(options), parseExtensionVectorIndexes(options), keyNode);

/**
 * Resolve + merge one `.extend(...)` call into a {@link MergedExtension}, or
 * `undefined` (with a `console.warn`) when the extension can't be resolved from
 * local sources or is malformed. Mirrors how codegen elsewhere warns rather
 * than crashing on inputs it can't statically resolve.
 */
const mergeExtendCall = (extendCall: CallExpression, projectRoot: string | undefined): MergedExtension | undefined => {
    const extendArgument = extendCall.getArguments()[0];

    if (!extendArgument) {
        return undefined;
    }

    const resolved = resolveSchemaExtensionCall(extendArgument);

    if (!resolved) {
        // AST resolution bailed (the extension lives in a published package, only
        // a `.d.ts` is reachable). When we know the project root, fall back to
        // importing the package and introspecting its runtime extension value
        // (Plan 056). Returns `undefined` on any failure → the warn+skip below.
        if (projectRoot !== undefined) {
            const fromPackage = resolvePackageExtension(extendArgument, projectRoot);

            if (fromPackage) {
                // The `.extend(...)` argument is the only node there is for a
                // package extension — the user cannot edit the package, but they
                // can at least see which extension is at fault and from where.
                return namespaceExtension(fromPackage.key, fromPackage.bareTables, fromPackage.bareVectorIndexes, extendArgument);
            }
        }

        // eslint-disable-next-line no-console -- codegen surfaces a clear, actionable warning when an extension cannot be resolved.
        console.warn(
            `@lunora/codegen: skipping \`.extend(${extendArgument.getText()})\` — its \`defineSchemaExtension(...)\` could not be resolved from local sources, and ${projectRoot === undefined ? "no project root was available to resolve the package" : "the package could not be imported/introspected"}. Extension tables will be absent from the generated types.`,
        );

        return undefined;
    }

    const parts = extensionPartsOf(resolved);

    if (!parts) {
        // eslint-disable-next-line no-console -- malformed extension call; warn rather than crash.
        console.warn(`@lunora/codegen: skipping \`.extend(...)\` — \`defineSchemaExtension\` requires a string \`key\` and an options object literal.`);

        return undefined;
    }

    return mergeExtension(parts.key, parts.keyNode, parts.options);
};

/**
 * Walk the chained `.extend(arg)` calls wrapping a `defineSchema(...)` call
 * (innermost → outermost) and return the {@link CallExpression}s, in source
 * order. `defineSchema({...}).extend(a).extend(b)` yields `[a-call, b-call]`.
 */
const extendCallsOf = (defineSchemaCall: CallExpression): CallExpression[] => {
    const calls: CallExpression[] = [];
    let current: TsNode = defineSchemaCall;

    // Each chained call is `CallExpression(PropertyAccessExpression(current, name))`.
    // Collect the `.extend(...)` links; transparently step over any other chained
    // builder method (e.g. `.rls("required")`) so a `defineSchema(...).rls(...)
    // .extend(...)` ordering still finds its extensions instead of stopping at
    // the first non-`extend` link.
    for (;;) {
        const parent = current.getParent();

        if (!parent || !Node.isPropertyAccessExpression(parent)) {
            break;
        }

        const callParent = parent.getParent();

        if (!callParent || !Node.isCallExpression(callParent)) {
            break;
        }

        if (parent.getName() === "extend") {
            calls.push(callParent);
        }

        current = callParent;
    }

    return calls;
};

/**
 * Merge every chained `.extend(...)` extension into `tables` (mutated in place)
 * and return the extension-contributed standalone vector indexes. Extension
 * tables are auto-prefixed with the extension key and intra-extension
 * references rewritten, mirroring the runtime `mergeSchemaExtension`.
 * Cross-package extensions (only reachable as a `.d.ts`) are skipped with a
 * warning — a deferred phase. Throws on a real post-prefix table collision.
 */
const applyExtensions = (defineSchemaCall: CallExpression, tables: TableIR[], projectRoot: string | undefined): VectorIndexIR[] => {
    const existingTableNames = new Set(tables.map((table) => table.name));
    const vectorIndexes: VectorIndexIR[] = [];

    for (const extendCall of extendCallsOf(defineSchemaCall)) {
        const merged = mergeExtendCall(extendCall, projectRoot);

        if (!merged) {
            continue;
        }

        for (const table of merged.tables) {
            if (existingTableNames.has(table.name)) {
                throw diagnosticAt(
                    extendCall,
                    `defineSchema(...).extend(...): table "${table.name}" already exists — another extension with the same key already contributed it.`,
                );
            }

            existingTableNames.add(table.name);
            tables.push(table);
        }

        vectorIndexes.push(...merged.vectorIndexes);
    }

    return vectorIndexes;
};

export { applyExtensions, parseStandaloneVectorIndexes };
