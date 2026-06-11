import { relative, sep } from "node:path";

import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listCirrusSourceFiles } from "./discover-functions";
import type { RlsProcedureIR } from "./ir";

/** Strips a trailing `.ts` extension from a relative source path. */
const TS_EXTENSION_RE = /\.ts$/u;

// ---------------------------------------------------------------------------
// Builder-chain helpers
// ---------------------------------------------------------------------------

/**
 * Walk a builder chain leftward from `receiver` (the expression to the left of
 * the terminal `.query(...)` / `.mutation(...)` call) and return `true` when any
 * `.use(rls(...))` step is found, together with the statically-readable table
 * names from the `rls(policies)` argument.
 *
 * Structure recognised (leftward):
 *
 *   c.use(rls([{ table: "documents", on: "read", when: ... }])).query(handler)
 *   ───────────────────── receiver ──────────────────────────── ─── terminal ───
 *
 * The chain is a nested `CallExpression` tree; each step is:
 *   - a `CallExpression` whose callee is a `PropertyAccessExpression`
 *   - the property name is the builder method (`.use`, `.input`, `.output`, …)
 *   - the argument is the middleware / validator / etc.
 *
 * We recognise a `.use(rls(...))` step when the property name is `"use"` and
 * the first argument is a `CallExpression` whose callee is an `Identifier` (or
 * `PropertyAccessExpression` with name) `"rls"`.
 */
const rlsFromBuilderChain = (receiver: TsNode): { rlsTables: string[]; usesRls: boolean } => {
    let node: TsNode = receiver;
    let usesRls = false;
    const rlsTables: string[] = [];

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "use") {
            const argument = node.getArguments()[0];

            if (argument && isRlsCall(argument)) {
                usesRls = true;

                // Extract table names from the rls(policies) argument array.
                rlsTables.push(...extractPolicyTables(argument as CallExpression));
            }
        }

        node = chainCallee.getExpression();
    }

    return { rlsTables, usesRls };
};

/**
 * True when `node` is a `CallExpression` whose callee resolves to the name
 * `"rls"` — either a bare identifier (`rls(policies)`) or a property access
 * (`rlsModule.rls(policies)`). We match by name rather than import origin so
 * the check is robust even when ts-morph has degraded type info.
 */
const isRlsCall = (node: TsNode): boolean => {
    if (!Node.isCallExpression(node)) {
        return false;
    }

    const callee = node.getExpression();

    if (Node.isIdentifier(callee)) {
        return callee.getText() === "rls";
    }

    if (Node.isPropertyAccessExpression(callee)) {
        return callee.getName() === "rls";
    }

    return false;
};

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
 * we capture the first string-literal argument when present).
 */
const WRITE_METHODS = new Set(["delete", "insert", "patch", "replace"]);

/** True when `call` is a `ctx.db.<method>(...)` or bare `db.<method>(...)` call. */
const isDbCall = (call: CallExpression, methodSet: Set<string>): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methodSet.has(callee.getName())) {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/**
 * String-literal first argument of a `ctx.db.<method>("table", ...)` call, or
 * `""` when the argument is not a string literal (dynamic table — not lintable).
 */
const tableArgOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover the set of tables read and written inside the lexical scope of an
 * ancestor `VariableDeclaration` (the exported procedure binding). We descend
 * from the declaration rather than from the terminal call so we also capture
 * reads/writes in helper closures defined inside the function body.
 */
const tablesAccessedIn = (declaration: TsNode): { tablesRead: string[]; tablesWritten: string[] } => {
    const tablesRead = new Set<string>();
    const tablesWritten = new Set<string>();

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isDbCall(call, READ_METHODS)) {
            const table = tableArgOf(call);

            if (table !== "") {
                tablesRead.add(table);
            }
        } else if (isDbCall(call, WRITE_METHODS)) {
            const table = tableArgOf(call);

            if (table !== "") {
                tablesWritten.add(table);
            }
        }
    }

    return { tablesRead: [...tablesRead], tablesWritten: [...tablesWritten] };
};

// ---------------------------------------------------------------------------
// Top-level discovery
// ---------------------------------------------------------------------------

/**
 * Discover RLS usage for every exported Cirrus procedure under the cirrus source
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
const discoverRlsProcedures = (project: Project, cirrusDirectory: string): RlsProcedureIR[] => {
    const FUNCTION_KINDS = new Set(["action", "mutation", "query", "stream"]);
    const INTERNAL_FACTORIES: Record<string, boolean> = {
        internalAction: true,
        internalMutation: true,
        internalQuery: true,
    };

    const procedures: RlsProcedureIR[] = [];

    for (const filePath of listCirrusSourceFiles(cirrusDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = relative(cirrusDirectory, filePath).replace(TS_EXTENSION_RE, "").split(sep).join("/");

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const exportName = declaration.getName();
                const initializer = declaration.getInitializer();

                if (!initializer || !Node.isCallExpression(initializer)) {
                    continue;
                }

                const callee = initializer.getExpression();

                let usesRls = false;
                let rlsTables: string[] = [];
                let visibility: "internal" | "public" = "public";

                if (Node.isPropertyAccessExpression(callee)) {
                    // Builder terminal: c.use(...).query(handler)
                    const method = callee.getName();

                    if (!FUNCTION_KINDS.has(method)) {
                        continue;
                    }

                    const receiverType = callee.getExpression().getType();

                    if (!receiverType.getProperty("__cirrusProcedure")) {
                        // Not a Cirrus builder — skip.
                        continue;
                    }

                    if (receiverType.getProperty("__cirrusVisibility")) {
                        visibility = "internal";
                    }

                    // Walk the chain for .use(rls(...)).
                    const chain = rlsFromBuilderChain(callee.getExpression());

                    usesRls = chain.usesRls;
                    rlsTables = chain.rlsTables;
                } else if (Node.isIdentifier(callee)) {
                    // Bare factory: query({...}) / internalQuery({...})
                    const calleeName = callee.getText();

                    if (!FUNCTION_KINDS.has(calleeName) && !INTERNAL_FACTORIES[calleeName]) {
                        continue;
                    }

                    if (INTERNAL_FACTORIES[calleeName]) {
                        visibility = "internal";
                    }

                    // Bare factory → no builder chain → usesRls always false.
                    usesRls = false;
                    rlsTables = [];
                } else {
                    continue;
                }

                const { tablesRead, tablesWritten } = tablesAccessedIn(declaration);

                procedures.push({
                    exportName,
                    file: relativePath,
                    rlsTables,
                    tablesRead,
                    tablesWritten,
                    usesRls,
                    visibility,
                });
            }
        }
    }

    return procedures;
};

export default discoverRlsProcedures;
