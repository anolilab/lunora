import { LunoraError } from "@lunora/errors";
import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { globalVectorIndexMessage } from "../../../../../shared/global-vector-index";
import { diagnosticAt } from "../../diagnostics";
import type { SchemaIR, TableIR, VectorIndexIR } from "../../ir";
import { descendantsOfKind } from "../ast";
import { applyExtensions, parseStandaloneVectorIndexes } from "./internal/extensions";
import { chainedStringLiteralArgument, getBooleanProperty, getStringProperty } from "./internal/properties";
import { parseBaseTables } from "./internal/table-builder";

/** Recognised Cloudflare DO data-residency jurisdictions — the literals a `.jurisdiction("…")` call may carry. */
const JURISDICTIONS = new Set<NonNullable<SchemaIR["jurisdiction"]>>(["eu", "fedramp", "us"]);

/**
 * The `.jurisdiction("…")` link's literal on the chain wrapping a `defineSchema(...)`
 * call (`defineSchema(...).rls(...).jurisdiction("us").extend(...)`), or `undefined`
 * when absent. Throws on an unrecognised literal so a typo fails loudly rather than
 * emitting an invalid jurisdiction. See {@link chainedStringLiteralArgument}.
 */
const jurisdictionOf = (defineSchemaCall: CallExpression): SchemaIR["jurisdiction"] =>
    chainedStringLiteralArgument(defineSchemaCall, "jurisdiction", "jurisdiction", JURISDICTIONS, '"eu", "us", or "fedramp"');

/**
 * Whether the chain's `.jurisdiction("…", { pinAuth: true })` carries the
 * acknowledgement that DO-backed auth moves into the jurisdiction. Only a
 * literal `true` counts: anything codegen cannot read is not an acknowledgement.
 */
const pinsAuth = (defineSchemaCall: CallExpression): boolean => {
    let current: TsNode = defineSchemaCall;

    for (;;) {
        const access = current.getParent();
        const call = access?.getParent();

        if (!access || !Node.isPropertyAccessExpression(access) || !call || !Node.isCallExpression(call)) {
            return false;
        }

        if (access.getName() === "jurisdiction") {
            const options = call.getArguments()[1];

            return options !== undefined && Node.isObjectLiteralExpression(options) && getBooleanProperty(options, "pinAuth") === true;
        }

        current = call;
    }
};

/** Recognised `.rls(...)` mode literals — currently only `"required"`. */
const RLS_MODES = new Set<NonNullable<SchemaIR["rlsMode"]>>(["required"]);

/**
 * The `.rls("required")` link's literal on the chain wrapping a `defineSchema(...)`
 * call (`defineSchema(...).rls("required").extend(...)`), or `undefined` when absent.
 * Throws on an unrecognised literal so a typo fails loudly rather than silently
 * treating the schema as RLS-unenforced. See {@link chainedStringLiteralArgument}.
 */
const rlsModeOf = (defineSchemaCall: CallExpression): SchemaIR["rlsMode"] =>
    chainedStringLiteralArgument(defineSchemaCall, "rls", "rls mode", RLS_MODES, '"required"');

/**
 * The tables a standalone aggregate block names — `defineSchema(tables, vectors, { name:
 * defineAggregateIndex(name, { on: "table", … }) })` — or `undefined` when any entry cannot
 * be read. An unreadable entry could name any table, so the caller then marks every table.
 */
const standaloneAggregateTables = (argument: TsNode): Set<string> | undefined => {
    if (!Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const tables = new Set<string>();

    for (const property of argument.getProperties()) {
        const initializer = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;

        if (!initializer || !Node.isCallExpression(initializer)) {
            return undefined;
        }

        const callee = initializer.getExpression();
        const options = initializer.getArguments()[1];
        const on = options && Node.isObjectLiteralExpression(options) ? getStringProperty(options, "on") : undefined;

        if (!Node.isIdentifier(callee) || callee.getText() !== "defineAggregateIndex" || on === undefined) {
            return undefined;
        }

        tables.add(on);
    }

    return tables;
};

/**
 * Mark each table a standalone aggregate index names as `aggregateIndexed`, so a `count()`
 * on it is not reported as a scan. An argument that cannot be read marks every table.
 */
const markStandaloneAggregates = (tables: TableIR[], argument: TsNode | undefined): void => {
    if (argument === undefined) {
        return;
    }

    const named = standaloneAggregateTables(argument);

    for (const table of tables) {
        if (named === undefined || named.has(table.name)) {
            table.aggregateIndexed = true;
        }
    }
};

/**
 * Load `<projectRoot>/lunora/schema.ts`, find `defineSchema({...})`, and
 * return a structural IR. Throws if the file or call cannot be found.
 */
const discoverSchema = (project: Project, schemaPath: string, projectRoot?: string): SchemaIR => {
    const file: SourceFile = project.addSourceFileAtPath(schemaPath);

    const defineSchemaCall = descendantsOfKind(file, SyntaxKind.CallExpression).find((call) => {
        const callee = call.getExpression();

        return Node.isIdentifier(callee) && callee.getText() === "defineSchema";
    });

    if (!defineSchemaCall) {
        throw new LunoraError("INTERNAL", `defineSchema() not found in ${schemaPath}`);
    }

    const argument = defineSchemaCall.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(defineSchemaCall, "defineSchema() expects an object literal");
    }

    const tables: TableIR[] = parseBaseTables(argument);

    // Standalone vector indexes live in the optional second argument (Shape B).
    const standaloneArgument = defineSchemaCall.getArguments()[1];
    const standaloneVectorIndexes =
        standaloneArgument && Node.isObjectLiteralExpression(standaloneArgument) ? parseStandaloneVectorIndexes(standaloneArgument) : [];

    // Merge chained `.extend(...)` extensions, mutating `tables` and collecting
    // their standalone vector indexes.
    const extensionStandaloneVectorIndexes = applyExtensions(defineSchemaCall, tables, projectRoot);

    // Standalone aggregate indexes live in the optional third argument; extension
    // tables are merged above, so they are marked too.
    markStandaloneAggregates(tables, defineSchemaCall.getArguments()[2]);

    // Flatten inline Shape A indexes (hoisted with their owning table) plus Shape B
    // plus extension-contributed standalone vector indexes.
    const vectorIndexes: VectorIndexIR[] = [...tables.flatMap((table) => table.vectorIndexes), ...standaloneVectorIndexes, ...extensionStandaloneVectorIndexes];

    // Same rule as `defineSchema`'s `validateGlobalVectors`, surfaced at generate
    // time: vector sync is a shard write hook, and a `.global()` table's writes
    // never take the shard path, so the index would stay empty.
    const globalTables = new Set(tables.filter((table) => table.shardMode === "global").map((table) => table.name));
    const globalVectorIndex = vectorIndexes.find((index) => globalTables.has(index.table));

    if (globalVectorIndex) {
        throw diagnosticAt(defineSchemaCall, globalVectorIndexMessage(globalVectorIndex.table, globalVectorIndex.name));
    }

    return {
        jurisdiction: jurisdictionOf(defineSchemaCall),
        ...(pinsAuth(defineSchemaCall) ? { jurisdictionPinsAuth: true as const } : {}),
        rlsMode: rlsModeOf(defineSchemaCall),
        tables,
        vectorIndexes,
    };
};

export default discoverSchema;
