import { LunoraError } from "@lunora/errors";
import type { CallExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../../diagnostics";
import type { SchemaIR, TableIR, VectorIndexIR } from "../../ir";
import { applyExtensions, parseStandaloneVectorIndexes } from "./internal/extensions";
import { chainedStringLiteralArgument } from "./internal/properties";
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
 * Load `<projectRoot>/lunora/schema.ts`, find `defineSchema({...})`, and
 * return a structural IR. Throws if the file or call cannot be found.
 */
const discoverSchema = (project: Project, schemaPath: string, projectRoot?: string): SchemaIR => {
    const file: SourceFile = project.addSourceFileAtPath(schemaPath);

    const defineSchemaCall = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
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

    // Flatten inline Shape A indexes (hoisted with their owning table) plus Shape B
    // plus extension-contributed standalone vector indexes.
    const vectorIndexes: VectorIndexIR[] = [...tables.flatMap((table) => table.vectorIndexes), ...standaloneVectorIndexes, ...extensionStandaloneVectorIndexes];

    return { jurisdiction: jurisdictionOf(defineSchemaCall), rlsMode: rlsModeOf(defineSchemaCall), tables, vectorIndexes };
};

export default discoverSchema;
