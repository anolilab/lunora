import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { InspectableHandler } from "./discover-functions";
import {
    chainUsesWrappedCall,
    classifyProcedureCall,
    isDatabaseAccessor,
    listLunoraSourceFiles,
    lunoraRelativePath,
    procedureHandler,
} from "./discover-functions";
import type { NormalizeIdAuthorizationIR } from "./ir";

/**
 * `ctx.db` id-first row operations that resolve a whole row by its primitive id:
 * `get(id)`, `patch(id, …)`, `delete(id)`. Each takes the id as argument 0, so a
 * `normalizeId` result flowing into `arg[0]` reaches the row directly — with no
 * ownership predicate in the read itself.
 */
const SINK_METHODS = new Set<NormalizeIdAuthorizationIR["sinkMethod"]>(["delete", "get", "patch"]);

/**
 * Identifier names that signal the handler already reasons about ownership /
 * tenancy — an intervening ownership predicate the negative-proof lint must not
 * flag over. A read/compare of any of these (or of `ctx.auth`/`ctx.identity`/…)
 * suppresses the finding: the handler is doing more than a shape check. Kept wide
 * on purpose — a false negative (a real IDOR we stay quiet on) is cheaper than a
 * false positive that trains users to ignore the advisor. This list is only one of
 * several ownership signals (see `handlerMentionsOwnership`); it does not need to
 * enumerate every possible column name.
 */
const OWNERSHIP_IDENTIFIER_NAMES = new Set<string>([
    "accountId",
    "authorId",
    "companyId",
    "createdBy",
    "createdById",
    "customerId",
    "groupId",
    "memberId",
    "organizationId",
    "orgId",
    "ownerId",
    "projectId",
    "teamId",
    "tenantId",
    "userId",
    "workspaceId",
]);

/** `ctx` sub-namespaces whose read implies the handler consults the caller's identity. */
const IDENTITY_ACCESSORS = new Set<string>(["auth", "identity", "session", "user"]);

/** Equality operators — an equality check against a loaded row's property (`row.ownerId !== viewer.id`) is an ownership comparison; range operators (`<`/`>`) almost never are, so they are excluded to avoid suppressing on an unrelated `arr.length > 0`. */
const EQUALITY_OPERATORS = new Set<SyntaxKind>([
    SyntaxKind.EqualsEqualsEqualsToken,
    SyntaxKind.EqualsEqualsToken,
    SyntaxKind.ExclamationEqualsEqualsToken,
    SyntaxKind.ExclamationEqualsToken,
]);

/**
 * The table a `ctx.db.normalizeId(table, id)` call validates against, or `undefined`
 * when `call` isn't a `normalizeId` on the database accessor. `""` when the table
 * argument isn't a string literal (a dynamic table — the schema join can't resolve
 * it, so the lint stays conservative).
 */
const normalizeIdTable = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "normalizeId" || !isDatabaseAccessor(callee.getExpression())) {
        return undefined;
    }

    const first = call.getArguments()[0];

    return first && Node.isStringLiteral(first) ? first.getLiteralText() : "";
};

/**
 * The `const` binding name capturing `call`'s result (`const id = ctx.db.normalizeId(…)`),
 * following one `as`/parenthesized/non-null wrapper hop, or `undefined` when the
 * result isn't bound to a simple name — an inline use has no gate to reason about.
 */
const bindingNameOf = (call: CallExpression): string | undefined => {
    let node: TsNode = call;
    let parent = node.getParent();

    while (parent !== undefined && (Node.isAsExpression(parent) || Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent))) {
        node = parent;
        parent = node.getParent();
    }

    // Reaching a variable declaration by ascending only through as/paren/non-null wrappers means our call sits in its initializer.
    if (parent === undefined || !Node.isVariableDeclaration(parent)) {
        return undefined;
    }

    const nameNode = parent.getNameNode();

    return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
};

/** True when any descendant identifier of `condition` is the name `name`. */
const conditionReferences = (condition: TsNode, name: string): boolean =>
    condition.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => identifier.getText() === name);

/** True when `node` is — or contains — an early-exit `throw`/`return` (a bare then-branch is the statement itself, not a block). */
const exitsControlFlow = (node: TsNode): boolean =>
    Node.isThrowStatement(node) ||
    Node.isReturnStatement(node) ||
    node.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.ReturnStatement).length > 0;

/**
 * True when the handler gates control flow on `name` — an `if` whose condition reads
 * `name` and whose then-branch throws or returns. This is the "used as authorization"
 * tell: the developer treats a non-null `normalizeId` result as permission to proceed.
 */
const hasNullGate = (handler: InspectableHandler, name: string): boolean =>
    handler
        .getDescendantsOfKind(SyntaxKind.IfStatement)
        .some((ifStatement) => conditionReferences(ifStatement.getExpression(), name) && exitsControlFlow(ifStatement.getThenStatement()));

/**
 * The id-first `ctx.db` sink method (`get`/`patch`/`delete`) the handler applies to
 * `name` as its first argument (`ctx.db.get(id)` / `ctx.db.<table>.patch(id, …)`), or
 * `undefined` when the normalized id never reaches such a sink.
 */
const idSinkMethod = (handler: InspectableHandler, name: string): NormalizeIdAuthorizationIR["sinkMethod"] | undefined => {
    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            continue;
        }

        const method = callee.getName() as NormalizeIdAuthorizationIR["sinkMethod"];

        if (!SINK_METHODS.has(method)) {
            continue;
        }

        const receiver = callee.getExpression();
        // Generic form `ctx.db.get(id)` or facade form `ctx.db.<table>.get(id)`.
        const onDatabase = isDatabaseAccessor(receiver) || (Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression()));

        if (!onDatabase) {
            continue;
        }

        const first = call.getArguments()[0];

        if (first !== undefined && Node.isIdentifier(first) && first.getText() === name) {
            return method;
        }
    }

    return undefined;
};

/**
 * The leftmost identifier of a dotted / indexed / awaited expression — `ctx` in
 * `ctx.auth.userId`, `viewer` in `viewer.teamId`, `undefined` for a literal or a
 * more complex head.
 */
const rootIdentifierName = (node: TsNode): string | undefined => {
    let current: TsNode = node;

    while (
        Node.isPropertyAccessExpression(current) ||
        Node.isElementAccessExpression(current) ||
        Node.isNonNullExpression(current) ||
        Node.isParenthesizedExpression(current) ||
        Node.isAsExpression(current) ||
        Node.isAwaitExpression(current)
    ) {
        current = current.getExpression();
    }

    return Node.isIdentifier(current) ? current.getText() : undefined;
};

/**
 * True when the handler passes `ctx` (or any `ctx.`-rooted value) into a function
 * call — `getViewer(ctx)`, `requireUser(ctx)`, `authorize(ctx, id)`. Delegating the
 * whole context to a helper is a strong tell that identity/authorization is resolved
 * out of line, so the handler is doing more than a shape check. A `ctx.db.get(id)`
 * method call does NOT match: there `ctx` is the receiver, not an argument.
 */
const delegatesContextToHelper = (handler: InspectableHandler): boolean =>
    handler.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => call.getArguments().some((argument) => rootIdentifierName(argument) === "ctx"));

/**
 * True when the handler contains an equality comparison with a property-access
 * operand — `invoice.customerId !== me.id`, `doc.teamId !== viewer.teamId`. Comparing
 * a loaded row's field against another value is an ownership/tenancy check regardless
 * of the column's name, so this catches the whole class without enumerating columns.
 * The `normalizeId` null gate (`if (!id)` / `id === null`) doesn't match — its operands
 * are the bare id binding and `null`, neither a property access — so a genuine
 * IDOR-shaped handler (validate, gate, use, with no field comparison) still fires.
 */
const comparesRowProperty = (handler: InspectableHandler): boolean =>
    handler.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((binary) => {
        if (!EQUALITY_OPERATORS.has(binary.getOperatorToken().getKind())) {
            return false;
        }

        return Node.isPropertyAccessExpression(binary.getLeft()) || Node.isPropertyAccessExpression(binary.getRight());
    });

/**
 * True when the handler shows any evidence it reasons about who owns the row — the
 * intervening ownership predicate the negative-proof lint must not flag over. Four
 * FN-biased signals, any of which suppresses the finding:
 *
 * 1. an ownership-named identifier (`ownerId`, `teamId`, `customerId`, …);
 * 2. a `ctx.auth`/`ctx.identity`/`ctx.session`/`ctx.user` read;
 * 3. identity delegated to a helper that receives `ctx` (`getViewer(ctx)`);
 * 4. an equality comparison on a loaded row's property (`row.ownerCol !== viewer.col`).
 *
 * Signals 3 and 4 make the rule robust to unlisted column names and to apps that
 * factor auth into a helper (good practice) — biasing hard toward silence so a
 * SECURITY-category finding never fires on genuinely-authorized code.
 */
const handlerMentionsOwnership = (handler: InspectableHandler): boolean => {
    for (const identifier of handler.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (OWNERSHIP_IDENTIFIER_NAMES.has(identifier.getText())) {
            return true;
        }
    }

    for (const access of handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const root = access.getExpression();

        if (Node.isIdentifier(root) && root.getText() === "ctx" && IDENTITY_ACCESSORS.has(access.getName())) {
            return true;
        }
    }

    return delegatesContextToHelper(handler) || comparesRowProperty(handler);
};

/** Reduce one exported `query`/`mutation` declaration to its `normalizeId`-as-authorization rows (deduped by binding). */
const normalizeIdAuthorizationsInDeclaration = (declaration: TsNode, relativePath: string): NormalizeIdAuthorizationIR[] => {
    if (!Node.isVariableDeclaration(declaration)) {
        return [];
    }

    const initializer = declaration.getInitializer();

    if (initializer === undefined || !Node.isCallExpression(initializer)) {
        return [];
    }

    const classified = classifyProcedureCall(initializer);

    // Only `ctx.db`-bearing procedures can call `normalizeId` — actions dispatch instead of reading rows.
    if (classified?.kind !== "query" && classified?.kind !== "mutation") {
        return [];
    }

    const handler = procedureHandler(initializer);

    if (handler === undefined) {
        return [];
    }

    const usesRls = classified.receiver !== undefined && chainUsesWrappedCall(classified.receiver, "use", "rls");
    const mentionsOwnership = handlerMentionsOwnership(handler);

    const seen = new Set<string>();
    const rows: NormalizeIdAuthorizationIR[] = [];

    for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const table = normalizeIdTable(call);

        if (table === undefined) {
            continue;
        }

        const name = bindingNameOf(call);

        if (name === undefined || seen.has(name) || !hasNullGate(handler, name)) {
            continue;
        }

        const sinkMethod = idSinkMethod(handler, name);

        if (sinkMethod === undefined) {
            continue;
        }

        seen.add(name);
        rows.push({
            exportName: declaration.getName(),
            file: relativePath,
            line: call.getStartLineNumber(),
            mentionsOwnership,
            sinkMethod,
            table,
            usesRls,
            visibility: classified.visibility,
        });
    }

    return rows;
};

/**
 * Discover `query`/`mutation` handlers under the lunora source directory that gate a
 * `ctx.db.get`/`patch`/`delete` on a `ctx.db.normalizeId(...)` result — the
 * `normalize_id_used_as_authorization` lint input. `normalizeId` validates an id's
 * structural shape only (it never reads the database), so a non-null result proves
 * the id is well-formed, never that the caller owns the row. Shape/name-based (no
 * type-checker dependency, so it runs pre-`pnpm install`) and fail-safe: only a
 * null-gated normalized id that reaches an id-first sink is recorded, and the handler
 * is scanned for any ownership/identity signal so the lint can stay silent whenever an
 * intervening ownership predicate is present. The lint owns the negative proof — it
 * filters to `visibility === "public"`, drops rows carrying `.use(rls(...))` or an
 * ownership mention, and joins `table` against the schema's RLS mode before flagging.
 */
const discoverNormalizeIdAuthorization = (project: Project, lunoraDirectory: string): NormalizeIdAuthorizationIR[] => {
    const rows: NormalizeIdAuthorizationIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                rows.push(...normalizeIdAuthorizationsInDeclaration(declaration, relativePath));
            }
        }
    }

    return rows;
};

export default discoverNormalizeIdAuthorization;
