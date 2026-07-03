import type { ArrowFunction, CallExpression, FunctionExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
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
 * false positive that trains users to ignore the advisor.
 */
const OWNERSHIP_IDENTIFIER_NAMES = new Set<string>([
    "accountId",
    "authorId",
    "createdBy",
    "createdById",
    "organizationId",
    "orgId",
    "ownerId",
    "tenantId",
    "userId",
    "workspaceId",
]);

/** `ctx` sub-namespaces whose read implies the handler consults the caller's identity. */
const IDENTITY_ACCESSORS = new Set<string>(["auth", "identity", "session", "user"]);

/** A function whose body we can inspect — an inline arrow or function expression handler. */
type InspectableHandler = ArrowFunction | FunctionExpression;

/** The inline arrow/function-expression handler at `argument`, or `undefined` when it isn't one. */
const inlineHandler = (argument: TsNode | undefined): InspectableHandler | undefined =>
    argument !== undefined && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;

/** True when `receiver` is the database accessor: `ctx.db` (property named `db`) or a bare `db`. */
const isDatabaseAccessor = (receiver: TsNode): boolean =>
    (Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db");

/**
 * The inline handler function of a classified procedure call, or `undefined` when
 * it isn't inspectable. The terminal call's first argument is either the handler
 * function directly (`mutation(async ({ ctx }) => …)` / `c.use(…).query(handler)`)
 * or an object literal carrying it under a `handler` property — both are handled.
 */
const procedureHandler = (initializer: CallExpression): InspectableHandler | undefined => {
    const argument = initializer.getArguments()[0];
    const direct = inlineHandler(argument);

    if (direct !== undefined) {
        return direct;
    }

    if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        return undefined;
    }

    const property = argument.getProperty("handler");

    return property !== undefined && Node.isPropertyAssignment(property) ? inlineHandler(property.getInitializer()) : undefined;
};

/** The simple name of a call's callee — a bare identifier's text or a property access's member name, else `""`. */
const calleeName = (callee: TsNode): string => {
    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
};

/** True when the builder chain rooted at `receiver` carries a `.use(rls(...))` step — a `.use(...)` whose first argument is a call to `rls`. */
const chainUsesRls = (receiver: TsNode): boolean => {
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        const argument = node.getArguments()[0];

        if (callee.getName() === "use" && argument !== undefined && Node.isCallExpression(argument) && calleeName(argument.getExpression()) === "rls") {
            return true;
        }

        node = callee.getExpression();
    }

    return false;
};

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
 * `name` as its first argument (`ctx.db.get(id)` / `ctx.db.&lt;table>.patch(id, …)`), or
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
 * True when the handler anywhere reads an ownership-named identifier or a
 * `ctx.auth`/`ctx.identity`/… namespace — evidence it reasons about who owns the
 * row (the intervening ownership predicate the negative-proof lint must not flag
 * over). Biases the rule toward silence: any ownership signal at all suppresses.
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

    return false;
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

    const usesRls = classified.receiver !== undefined && chainUsesRls(classified.receiver);
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
