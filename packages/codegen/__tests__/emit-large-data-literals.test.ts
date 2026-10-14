/**
 * Data tables that grow with the project must typecheck at any size (#823).
 *
 * `emitShard` used to write `LUNORA_ADVISORIES` (and the other studio tables) as
 * one array literal. TypeScript types an array literal element by element and
 * subtype-reduces the resulting union pairwise, so past ~1,150 advisories the
 * consumer's `tsc` failed with TS2590 ("Expression produces a union type that is
 * too complex to represent") while codegen itself exited 0. A declared type,
 * `as`, or `satisfies` does not help: each still types the literal first.
 *
 * These tests emit each table well past that threshold and compile the emitted
 * declarations with the TypeScript compiler, against the real `@lunora/do` types
 * the shard imports.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdvisorProcedureProtection, Finding } from "@lunora/advisor";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";
import type { TableIR } from "../src/ir";
import { emitOpenApiModule } from "../src/openapi";
import { emitOpenRpcModule } from "../src/openrpc";
import emittedJsonData from "./emitted-json-data";

const here = dirname(fileURLToPath(import.meta.url));

/** Well past the ~1,150 findings the issue measured TS2590 at. */
const SCALE = 5000;

/** Rules the synthetic findings are spread over; each has its own `metadata` shape, as real lints do. */
const RULES = 20;

/**
 * Compile `source` as a module next to this test (so `@lunora/do` resolves
 * through codegen's own `node_modules`) and return every diagnostic as text.
 */
const typecheck = (source: string): string[] => {
    const fileName = join(here, "__large-data-literals__.ts");
    const options: ts.CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);

    host.getSourceFile = (name, languageVersion, ...rest) =>
        name === fileName ? ts.createSourceFile(name, source, languageVersion, true) : getSourceFile(name, languageVersion, ...rest);

    const program = ts.createProgram([fileName], options, host);

    return ts
        .getPreEmitDiagnostics(program, program.getSourceFile(fileName))
        .map((diagnostic) => `TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
};

/** The shard's `import type … from "@lunora/do"` plus the named top-level `const` statements, as a standalone module. */
const pickDeclarations = (shard: string, names: ReadonlyArray<string>): string => {
    const file = ts.createSourceFile("shard.ts", shard, ts.ScriptTarget.ES2022, true);
    const typeImport = file.statements.find(
        (statement) =>
            ts.isImportDeclaration(statement) &&
            statement.importClause?.isTypeOnly === true &&
            (statement.moduleSpecifier as ts.StringLiteral).text === "@lunora/do",
    );
    const byName = new Map(
        file.statements
            .filter((statement) => ts.isVariableStatement(statement))
            .map((statement) => [statement.declarationList.declarations[0]!.name.getText(file), statement.getText(file)]),
    );
    const picked = names.map((name) => byName.get(name));

    expect(typeImport).toBeDefined();
    expect(picked).not.toContain(undefined);

    return `${[typeImport!.getText(file), ...picked].join("\n")}\nexport {};\n`;
};

/**
 * Findings grouped by rule, the order the advisor emits them in (one lint at a
 * time). The grouping is what makes the literal expensive: an element of the last
 * rule is compared against every earlier rule's elements before it meets its own.
 */
const findings = (count: number): Finding[] =>
    Array.from({ length: count }, (_, index) => {
        const rule = Math.floor((index * RULES) / count);

        return {
            cacheKey: `rule_${String(rule)}:${String(index)}`,
            categories: rule % 2 === 0 ? ["SECURITY"] : ["PERFORMANCE", "SCHEMA"],
            description: [
                `Rule ${String(rule)} with "quotes"`,
                String.raw`a \ backslash`,
                `a ${String.fromCodePoint(0x20_28)} line separator and </script>.`,
            ].join(", "),
            detail: `Occurrence ${String(index)}`,
            facing: rule % 3 === 0 ? "EXTERNAL" : "INTERNAL",
            level: (["ERROR", "INFO", "WARN"] as const)[rule % 3]!,
            metadata: { exportName: `fn${String(index)}`, file: `file${String(index % 97)}`, [`key${String(rule)}`]: `value${String(index)}`, line: index },
            name: `rule_${String(rule)}`,
            remediation: `Fix rule ${String(rule)}.`,
            title: `Rule ${String(rule)}`,
        };
    });

/** Procedures whose boolean facts vary, so their element types are mutually incompatible. */
const procedures = (count: number): AdvisorProcedureProtection[] =>
    Array.from({ length: count }, (_, index) => {
        // eslint-disable-next-line no-bitwise -- spreads the index over independent boolean facts
        const bit = (n: number): boolean => (index & (1 << n)) !== 0;

        return {
            callsMail: bit(0),
            emitsEvent: bit(1),
            exportName: `fn${String(index)}`,
            fanOut: bit(2),
            file: `file${String(index % 97)}`,
            handlesErrors: bit(3),
            kind: (["action", "mutation", "query"] as const)[index % 3]!,
            reachesOutbound: bit(4),
            usesCaptcha: bit(5),
            usesEmailGate: false,
            usesMask: bit(6),
            usesRateLimit: false,
            usesRls: bit(7),
            visibility: index % 4 === 0 ? "internal" : "public",
        };
    });

const tables = (count: number): TableIR[] =>
    Array.from({ length: count }, (_, index): TableIR => {
        return {
            indexes: [{ fields: ["owner"], name: "by_owner" }],
            name: `t${String(index)}`,
            rankIndexes: [],
            relations: [],
            searchIndexes: [],
            shape: {
                file: { kind: "storage" },
                owner: { kind: "id", tableName: `t${String((index + 1) % count)}` },
                title: { kind: "string" },
            },
            shardMode: "root",
            ttl: { field: "title" },
            vectorIndexes: [],
        };
    });

describe("generated data tables typecheck at project scale (#823)", () => {
    it(`compiles ${String(SCALE)} advisories and advisor procedures without TS2590`, () => {
        expect.assertions(3);

        const shard = emitShard({ advisories: findings(SCALE), advisorProcedures: procedures(SCALE), schema: { tables: [], vectorIndexes: [] } });

        expect(typecheck(pickDeclarations(shard, ["LUNORA_ADVISORIES", "LUNORA_ADVISOR_PROCEDURES"]))).toStrictEqual([]);
    }, 120_000);

    it("round-trips the data exactly through the emitted string literal", () => {
        expect.assertions(2);

        // Quotes, backslashes, U+2028 and `</script>` all survive the double encoding.
        const advisories = findings(RULES);
        const advisorProcedures = procedures(16);
        const shard = emitShard({ advisories, advisorProcedures, schema: { tables: [], vectorIndexes: [] } });

        expect(emittedJsonData(shard, "LUNORA_ADVISORIES")).toStrictEqual(advisories);
        expect(emittedJsonData(shard, "LUNORA_ADVISOR_PROCEDURES")).toStrictEqual(advisorProcedures);
    });

    it(`compiles the per-table schema tables for ${String(SCALE)} tables without TS2590`, () => {
        expect.assertions(3);

        const shard = emitShard({ schema: { tables: tables(SCALE), vectorIndexes: [] } });

        expect(
            typecheck(
                pickDeclarations(shard, ["LUNORA_TABLE_REFS", "LUNORA_TABLE_INDEXES", "LUNORA_TABLE_COLUMNS", "LUNORA_STORAGE_COLUMNS", "LUNORA_TTL_SWEEPS"]),
            ),
        ).toStrictEqual([]);
    }, 120_000);

    it(`compiles the OpenAPI and OpenRPC modules for ${String(SCALE)} procedures without TS2590`, () => {
        expect.assertions(2);

        // Every procedure's argument schema has its own property set, as real ones do.
        const methods = Array.from({ length: SCALE }, (_, index) => {
            return {
                name: `file${String(index)}:fn`,
                params: [{ name: "args", schema: { properties: { [`arg${String(index)}`]: { type: "string" } }, type: "object" } }],
                result: { name: "result", schema: {} },
            };
        });
        const paths = Object.fromEntries(
            Array.from({ length: SCALE }, (_, index) => [
                `/api/file${String(index)}/fn`,
                { post: { operationId: `op${String(index)}`, ...(index % 2 === 0 ? { deprecated: true } : {}) } },
            ]),
        );

        expect(typecheck(emitOpenRpcModule({ methods, openrpc: "1.3.2" }))).toStrictEqual([]);
        expect(typecheck(emitOpenApiModule({ openapi: "3.1.0", paths }))).toStrictEqual([]);
    }, 120_000);
});
