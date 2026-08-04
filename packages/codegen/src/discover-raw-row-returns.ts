import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { singleHopInitializer } from "./argument-taint";
import type { InspectableHandler } from "./discover-functions";
import {
    chainHasStep,
    chainUsesWrappedCall,
    classifyProcedureCall,
    isDatabaseAccessor,
    listLunoraSourceFiles,
    lunoraRelativePath,
    procedureHandler,
} from "./discover-functions";
import type { RawRowReturnIR } from "./ir";

/** `ctx.db` read methods that hand back a whole row (or array of rows): the by-id `get` and the `findFirst`/`findMany` family. */
const ROW_READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany", "get"]);

/**
 * The table a direct `ctx.db` row read addresses, or `undefined` when `call` isn't
 * one. Facade form `ctx.db.<table>.findMany(...)` puts the table in the receiver's
 * property name; table-arg form `ctx.db.findMany("table", ...)` puts it in the
 * string-literal argument 0. `""` when the table-arg form's first argument isn't a
 * string literal (a dynamic table — not lintable).
 */
const directRowReadTable = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !ROW_READ_METHODS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    // Table-arg form: `ctx.db.findMany("table", …)` / `ctx.db.get("table", id)`.
    if (isDatabaseAccessor(receiver)) {
        const first = call.getArguments()[0];

        return first && Node.isStringLiteral(first) ? first.getLiteralText() : "";
    }

    // Facade form: `ctx.db.<table>.findMany(…)` — the receiver's inner expression is the `db` accessor.
    if (Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression())) {
        return receiver.getName();
    }

    return undefined;
};

/**
 * The table of a fluent reader chain rooted at `ctx.db.query("table")` (e.g.
 * `ctx.db.query("users").withIndex(…).collect()`), or `undefined` when no such
 * root is in the chain. Walks the call chain leftward to the innermost
 * `query(...)` on the `db` accessor; `""` when its argument isn't a string literal.
 */
const fluentReaderTable = (call: CallExpression): string | undefined => {
    let node: TsNode = call;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            return undefined;
        }

        if (callee.getName() === "query" && isDatabaseAccessor(callee.getExpression())) {
            const first = node.getArguments()[0];

            return first && Node.isStringLiteral(first) ? first.getLiteralText() : "";
        }

        node = callee.getExpression();
    }

    return undefined;
};

/** Peel `await` / parentheses / non-null `!` / `as` casts off `node` to reach the underlying expression. */
const unwrapExpression = (node: TsNode): TsNode => {
    let current = node;

    while (Node.isAwaitExpression(current) || Node.isParenthesizedExpression(current) || Node.isNonNullExpression(current) || Node.isAsExpression(current)) {
        current = current.getExpression();
    }

    return current;
};

/**
 * The table whose raw rows `expression` returns, or `undefined` when it isn't a raw
 * read. A raw read is a direct `ctx.db` row read, a `ctx.db.query(...)` fluent
 * chain, or a bare identifier bound (one local `const` hop) to either. A hand-built
 * object / array literal, a `.map(...)` projection, or a primitive is deliberately
 * not a raw read — the developer already shaped the output, so the nudge stays
 * quiet. `hopped` bounds the identifier follow to a single hop.
 */
const rawRowReadTable = (expression: TsNode, hopped = false): string | undefined => {
    const node = unwrapExpression(expression);

    if (Node.isIdentifier(node)) {
        if (hopped) {
            return undefined;
        }

        const initializer = singleHopInitializer(node);

        return initializer === undefined ? undefined : rawRowReadTable(initializer, true);
    }

    if (!Node.isCallExpression(node)) {
        return undefined;
    }

    return directRowReadTable(node) ?? fluentReaderTable(node);
};

/**
 * The `return` expressions that belong directly to `handler` — a concise-body
 * arrow's body, or every `return` whose nearest enclosing function IS the handler
 * (so a `return` inside a `.map(row => …)` callback or a nested helper closure is
 * not mistaken for the handler's own return).
 */
const handlerReturnExpressions = (handler: InspectableHandler): TsNode[] => {
    const body = handler.getBody();

    if (!Node.isBlock(body)) {
        return [body]; // concise-body arrow: the body is the return expression.
    }

    const expressions: TsNode[] = [];

    for (const statement of handler.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        const enclosing = statement.getFirstAncestor(
            (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor),
        );

        const expression = statement.getExpression();

        if (enclosing === handler && expression !== undefined) {
            expressions.push(expression);
        }
    }

    return expressions;
};

/** Reduce one exported `query` declaration to the raw-row-return rows its handler produces (deduped by table). */
const rawRowReturnsInDeclaration = (declaration: TsNode, relativePath: string): RawRowReturnIR[] => {
    if (!Node.isVariableDeclaration(declaration)) {
        return [];
    }

    const initializer = declaration.getInitializer();

    if (initializer === undefined || !Node.isCallExpression(initializer)) {
        return [];
    }

    const classified = classifyProcedureCall(initializer);

    // Only queries hand rows to a caller as their result — a mutation/action `return` is a command result, not a read projection.
    if (classified?.kind !== "query") {
        return [];
    }

    const handler = procedureHandler(initializer);

    if (handler === undefined) {
        return [];
    }

    const usesOutput = classified.receiver !== undefined && chainHasStep(classified.receiver, "output");
    const usesMask = classified.receiver !== undefined && chainUsesWrappedCall(classified.receiver, "use", "mask");

    const seen = new Set<string>();
    const rows: RawRowReturnIR[] = [];

    for (const expression of handlerReturnExpressions(handler)) {
        const table = rawRowReadTable(expression);

        if (table === undefined || seen.has(table)) {
            continue;
        }

        seen.add(table);
        rows.push({
            exportName: declaration.getName(),
            file: relativePath,
            line: expression.getStartLineNumber(),
            table,
            usesMask,
            usesOutput,
            visibility: classified.visibility,
        });
    }

    return rows;
};

/* eslint-disable no-secrets/no-secrets -- the referenced advisor lint rule id in the doc comment, not a credential */

/**
 * Discover `query` handlers under the lunora source directory that `return` the
 * raw rows of a table (a `ctx.db` row read or `ctx.db.query(...)` fluent chain,
 * returned directly or through one local `const` hop, with no hand-built
 * projection) — the `output_projection_missing_on_public_read` lint input.
 * Shape/name-based (no type-checker dependency, so it runs pre-`pnpm install`) and
 * fail-safe: a handler that already shapes its output, or whose read table can't be
 * resolved to a string literal, is not recorded. The lint owns the policy — it
 * filters to `visibility === "public"`, drops rows with `.output(...)`/mask, and
 * joins `table` against the schema's PII-named columns before flagging.
 */
const discoverRawRowReturns = (project: Project, lunoraDirectory: string): RawRowReturnIR[] => {
    const rows: RawRowReturnIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                rows.push(...rawRowReturnsInDeclaration(declaration, relativePath));
            }
        }
    }

    return rows;
};

export default discoverRawRowReturns;
