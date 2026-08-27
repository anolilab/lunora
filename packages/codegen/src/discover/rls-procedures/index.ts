import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { RlsProcedureIR } from "../../ir";
import { listLunoraSourceFiles, lunoraRelativePath, tablesAccessedIn } from "../ast";
import { classifyProcedureCall } from "../functions/classify-procedure-call";
import { rlsCallsInChain } from "./internal-chain";

/**
 * Extract the string-literal `table` property values from the first argument of
 * an `rls(policies)` call. `policies` is expected to be an array literal of
 * object literals, each with a `table: "name"` property assignment.
 *
 * When the argument is not a literal array (a variable reference), returns `[]`
 * (conservative: `usesRls` is still `true` but table names are unknown).
 */
const extractPolicyTables = (rlsCall: CallExpression): string[] => {
    const argument = rlsCall.getArguments()[0];

    if (!argument || !Node.isArrayLiteralExpression(argument)) {
        // Non-literal array → can't enumerate tables statically.
        return [];
    }

    const tables: string[] = [];

    for (const element of argument.getElements()) {
        if (!Node.isObjectLiteralExpression(element)) {
            continue;
        }

        const tableProperty = element.getProperty("table");

        if (!tableProperty || !Node.isPropertyAssignment(tableProperty)) {
            continue;
        }

        const initializer = tableProperty.getInitializer();

        if (initializer && Node.isStringLiteral(initializer)) {
            tables.push(initializer.getLiteralText());
        }
    }

    return tables;
};

/**
 * Lint view of a builder chain: whether it carries any `.use(rls(...))` and the
 * statically-readable table names from those `rls(policies)` arguments.
 */
const rlsFromBuilderChain = (receiver: TsNode): { rlsTables: string[]; usesRls: boolean } => {
    const calls = rlsCallsInChain(receiver);

    return { rlsTables: calls.flatMap((call) => extractPolicyTables(call)), usesRls: calls.length > 0 };
};

// ---------------------------------------------------------------------------
// Table-access discovery inside a function body
// ---------------------------------------------------------------------------

/**
 * Read-access call sites: `ctx.db.query("table")` / `db.query("table")`,
 * `ctx.db.findMany("table", ...)` / `db.findMany("table", ...)`, and the same
 * for `findFirst` / `findFirstOrThrow` / `get`. These are the public
 * `DatabaseWriter` read entry points that RLS wraps.
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany", "get", "query"]);

/**
 * Write-access call sites: `ctx.db.insert("table", ...)` / `db.insert(...)`,
 * and `patch` / `replace` / `delete` (id-based, table isn't always a literal —
 * we capture the first string-literal argument when present). The batch forms
 * (`insertMany("table", …)`, `deleteMany`/`patchMany`) write through the same
 * paths, so they count as writes too — otherwise a procedure that writes a
 * policy-gated table ONLY via a batch method would slip past the
 * `rls-uncovered-table` advisor.
 */
const WRITE_METHODS = new Set(["delete", "deleteMany", "insert", "insertMany", "patch", "patchMany", "replace"]);

// ---------------------------------------------------------------------------
// Top-level discovery
// ---------------------------------------------------------------------------

/**
 * Discover RLS usage for every exported Lunora procedure under the lunora source
 * directory. For each procedure, records whether its builder chain includes
 * `.use(rls(...))`, which tables the `rls(policies)` argument names, and which
 * tables the procedure reads/writes through `ctx.db`.
 *
 * Only functions registered via the **builder** form (`c.use(...).query(...)`)
 * can carry `.use(rls(...))`; the bare-factory form (`query({ handler })`) never
 * has a builder chain, so those procedures are always `usesRls: false` with empty
 * `rlsTables`. Both forms are still included so the lint can flag bare-factory
 * procedures that touch policy-covered tables.
 */
const procedureIrFromDeclaration = (declaration: TsNode, relativePath: string): RlsProcedureIR | undefined => {
    if (!Node.isVariableDeclaration(declaration)) {
        return undefined;
    }

    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    // Shared classification (kind + visibility + builder receiver) —
    // single source of truth with function discovery.
    const classified = classifyProcedureCall(initializer);

    if (!classified) {
        return undefined;
    }

    // Only the builder form (`c.use(...).query(...)`) can carry
    // `.use(rls(...))`; a bare factory has no chain → never uses RLS.
    const chain = classified.receiver ? rlsFromBuilderChain(classified.receiver) : { rlsTables: [], usesRls: false };
    const { tablesRead, tablesWritten } = tablesAccessedIn(declaration, READ_METHODS, WRITE_METHODS);

    return {
        exportName: declaration.getName(),
        file: relativePath,
        rlsTables: chain.rlsTables,
        tablesRead,
        tablesWritten,
        usesRls: chain.usesRls,
        visibility: classified.visibility,
    };
};

const discoverRlsProcedures = (project: Project, lunoraDirectory: string): RlsProcedureIR[] => {
    const procedures: RlsProcedureIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const ir = procedureIrFromDeclaration(declaration, relativePath);

                if (ir) {
                    procedures.push(ir);
                }
            }
        }
    }

    return procedures;
};

export default discoverRlsProcedures;
