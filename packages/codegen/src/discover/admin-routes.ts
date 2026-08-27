import type { CallExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { AdminRouteIR } from "./ir";

/** The `httpRoute.<verb>(...)` factory verbs. */
const HTTP_VERBS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

/** The terminal steps that close a route builder chain into a mountable handler. */
const TERMINAL_STEPS = new Set(["handler", "stream"]);

/** A path is admin/privileged-looking when a segment names an administrative surface. */
const ADMIN_PATH_RE = /\/(?:_|admin|internal|superuser|sudo|root|debug)/iu;

/**
 * Guard names whose reference inside the handler *body* counts as an auth/admin
 * check. Matched against real AST references — a property-access member name
 * (`ctx.auth`, `ctx.identity`, `session.isAdmin`) or a call callee
 * (`getSession(...)`, `requireAdmin(...)`) — never a substring over the route's
 * source text, so the path literal and comments can't false-clear a route.
 */
const GUARD_NAMES = new Set([
    "ADMIN_TOKEN",
    "adminToken",
    "assertAdmin",
    "assertAuth",
    "auth",
    "Authorization",
    "getSession",
    "identity",
    "isAdmin",
    "requireAdmin",
    "requireAuth",
    "requireRole",
    "verifyAdmin",
]);

/** Resolve a builder chain's root `httpRoute.<verb>("/path")`, returning `{ method, path }` or `undefined`. */
const readRootVerb = (node: TsNode): { method: string; path: string } | undefined => {
    if (!Node.isCallExpression(node)) {
        return undefined;
    }

    const callee = node.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !HTTP_VERBS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    if (!Node.isIdentifier(receiver) || receiver.getText() !== "httpRoute") {
        return undefined;
    }

    const first = node.getArguments()[0];

    if (!first || !Node.isStringLiteral(first)) {
        return undefined;
    }

    return { method: callee.getName().toUpperCase(), path: first.getLiteralValue() };
};

/** Walk a route chain leftward from the terminal call to its `httpRoute.<verb>(path)` root. */
const rootOfChain = (terminalCall: CallExpression): { method: string; path: string } | undefined => {
    const terminalCallee = terminalCall.getExpression();

    if (!Node.isPropertyAccessExpression(terminalCallee)) {
        return undefined;
    }

    let node: TsNode = terminalCallee.getExpression();

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            break;
        }

        if (HTTP_VERBS.has(callee.getName())) {
            break;
        }

        node = callee.getExpression();
    }

    return readRootVerb(node);
};

/**
 * True when a guard reference is unambiguously present in `handlerBody` — a
 * property-access member name (`ctx.auth`, `session.isAdmin`) or a call callee
 * (`getSession(...)`, `requireAdmin(...)`) whose name is in {@link GUARD_NAMES}.
 * Walks the real AST of the handler body only, so neither the route path literal
 * nor comments can spuriously clear the route.
 */
const handlerReferencesGuard = (handlerBody: TsNode): boolean => {
    for (const access of handlerBody.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (GUARD_NAMES.has(access.getName())) {
            return true;
        }
    }

    for (const call of handlerBody.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();

        if (Node.isIdentifier(callee) && GUARD_NAMES.has(callee.getText())) {
            return true;
        }
    }

    return false;
};

/** Build the {@link AdminRouteIR} for one exported `httpRoute` declaration on an admin path, or `undefined`. */
const adminRouteFromDeclaration = (declaration: VariableDeclaration, relativePath: string): AdminRouteIR | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const callee = initializer.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !TERMINAL_STEPS.has(callee.getName())) {
        return undefined;
    }

    const root = rootOfChain(initializer);

    if (!root || !ADMIN_PATH_RE.test(root.path)) {
        return undefined;
    }

    // Guard detection is scoped to the terminal `.handler(...)` / `.stream(...)`
    // callback and matched via the AST — never a substring over the whole
    // declaration. A non-callback (or absent) handler argument is treated as
    // unguarded so the security lint fails closed rather than auto-clearing on a
    // token in the path or a comment.
    const handlerArgument = initializer.getArguments()[0];
    const usesGuard =
        handlerArgument !== undefined &&
        (Node.isArrowFunction(handlerArgument) || Node.isFunctionExpression(handlerArgument)) &&
        handlerReferencesGuard(handlerArgument);

    return { exportName: declaration.getName(), file: relativePath, method: root.method, path: root.path, usesGuard };
};

/** Admin-path routes in one source file. */
const adminRoutesInSourceFile = (sourceFile: SourceFile, relativePath: string): AdminRouteIR[] => {
    const found: AdminRouteIR[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const ir = adminRouteFromDeclaration(declaration, relativePath);

            if (ir) {
                found.push(ir);
            }
        }
    }

    return found;
};

/**
 * Discover `httpRoute.<verb>("/admin/…")` REST routes on admin/privileged-looking
 * paths and whether each references an auth/admin guard in its handler — the
 * `admin_route_without_guard` lint input. A privileged route with no visible
 * session/admin check is an authorization gap, so only the path + guard-presence
 * fact is recorded; the lint decides severity.
 */
const discoverAdminRoutes = (project: Project, lunoraDirectory: string): AdminRouteIR[] => {
    const routes: AdminRouteIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        routes.push(...adminRoutesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return routes;
};

export default discoverAdminRoutes;
