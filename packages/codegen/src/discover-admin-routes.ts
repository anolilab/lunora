import type { CallExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { AdminRouteIR } from "./ir";

/** The `httpRoute.&lt;verb&gt;(...)` factory verbs. */
const HTTP_VERBS = new Set(["delete", "get", "head", "options", "patch", "post", "put"]);

/** The terminal steps that close a route builder chain into a mountable handler. */
const TERMINAL_STEPS = new Set(["handler", "stream"]);

/** A path is admin/privileged-looking when a segment names an administrative surface. */
const ADMIN_PATH_RE = /\/(?:_|admin|internal|superuser|sudo|root|debug)/iu;

/**
 * Identifiers / member names whose presence in a handler body counts as an
 * auth/admin guard. Deliberately broad — a route that references *any* of these
 * is treated as guarded, so the lint only fires on routes with no visible check.
 */
const GUARD_RE =
    /\b(?:adminToken|ADMIN_TOKEN|assertAdmin|assertAuth|auth|Authorization|getSession|identity|isAdmin|requireAdmin|requireAuth|requireRole|verifyAdmin)\b/u;

/** Resolve a builder chain's root `httpRoute.&lt;verb&gt;("/path")`, returning `{ method, path }` or `undefined`. */
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

/** Walk a route chain leftward from the terminal call to its `httpRoute.&lt;verb&gt;(path)` root. */
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

    // Guard detection scans the whole declaration (handler + any helper closures
    // inside it) for a reference to an auth/admin guard.
    const usesGuard = GUARD_RE.test(declaration.getText());

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
 * Discover `httpRoute.&lt;verb&gt;("/admin/…")` REST routes on admin/privileged-looking
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
