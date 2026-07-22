import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AdvisorNotifyCall, AdvisorNotifyConfig } from "@lunora/advisor";
import type { CallExpression, Expression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";

/** The only file a `@lunora/notify` provider may be declared in — mirrors `lunora/flags.ts`. */
const NOTIFY_FILENAME = "notify.ts";

/** `ctx.notify.&lt;method>` sends the `notify_send_outside_action` lint records (single-channel + multi-channel senders). */
const NOTIFY_SEND_METHODS = new Set(["chat", "inApp", "send", "webhook"]);

/** `ctx.push.&lt;method>` sends the lint records — the two device-push delivery calls (register/list/unregister are store ops, not sends). */
const PUSH_SEND_METHODS = new Set(["broadcast", "send"]);

/**
 * The handler function of a query/mutation registration — its terminal-builder
 * argument or the `handler:` property of the bare-factory object literal. Returns
 * `undefined` when the handler isn't a statically recognisable function
 * expression. Mirrors `discoverR2sqlCalls` / `discoverNondeterministicCalls`.
 */
const handlerOf = (call: CallExpression, receiver: TsNode | undefined): TsNode | undefined => {
    // Builder terminal: the handler is the terminal call's first argument.
    if (receiver) {
        const handler = call.getArguments()[0];

        return handler && (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) ? handler : undefined;
    }

    // Bare factory: pull the `handler:` property off the first object-literal argument.
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return undefined;
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return undefined;
    }

    const initializer = handlerProperty.getInitializer();

    return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) ? initializer : undefined;
};

/** One resolved handler with its attribution (kind kept broad so the push-usage scan can include actions). */
interface ResolvedProcedure {
    exportName: string;
    handler: TsNode;
    kind: string;
}

/**
 * The handler of an exported procedure declaration, with its attribution (export
 * name + registration kind), or `undefined` when the declaration isn't an
 * exported Lunora procedure with a statically recognisable handler. Unlike
 * `discoverR2sqlCalls`, actions are kept (the push-usage scan spans every kind);
 * the caller filters to `query`/`mutation` for the outside-action lint.
 */
const exportedProcedureHandler = (declaration: VariableDeclaration): ResolvedProcedure | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const classified = classifyProcedureCall(initializer);

    if (!classified) {
        return undefined;
    }

    const handler = handlerOf(initializer, classified.receiver);

    return handler ? { exportName: declaration.getName(), handler, kind: classified.kind } : undefined;
};

/** Every exported procedure handler in one source file. */
const proceduresInSourceFile = (sourceFile: SourceFile): ResolvedProcedure[] => {
    const found: ResolvedProcedure[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const procedure = exportedProcedureHandler(declaration);

            if (procedure) {
                found.push(procedure);
            }
        }
    }

    return found;
};

/**
 * Resolve a `ctx.notify` / `ctx.push` / `ctx.notify.push` receiver chain to its
 * facade label, or `undefined` when the node isn't one. Anchored on a literal
 * `ctx` identifier (a destructured `const { notify } = ctx` binding is too
 * ambiguous to claim — mirrors the `ctx.flags` / `ctx.r2sql` feeders).
 */
const facadeOf = (node: TsNode): "notify" | "push" | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const name = node.getName();
    const receiver = node.getExpression();

    // `ctx.notify` / `ctx.push`
    if ((name === "notify" || name === "push") && Node.isIdentifier(receiver) && receiver.getText() === "ctx") {
        return name;
    }

    // `ctx.notify.push` — the push sub-facade reachable off `ctx.notify`.
    if (name === "push" && facadeOf(receiver) === "notify") {
        return "push";
    }

    return undefined;
};

/**
 * The send-surface label for a property access, or `undefined` when the access is
 * not a `@lunora/notify` send. `ctx.notify.push.broadcast` normalises to
 * `ctx.push.broadcast` (the sub-facade is the same object).
 */
const notifyCalleeOf = (access: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(access)) {
        return undefined;
    }

    const method = access.getName();
    const facade = facadeOf(access.getExpression());

    if (facade === "notify" && NOTIFY_SEND_METHODS.has(method)) {
        return `ctx.notify.${method}`;
    }

    if (facade === "push" && PUSH_SEND_METHODS.has(method)) {
        return `ctx.push.${method}`;
    }

    return undefined;
};

/** True when the access is a `ctx.push.send` / `ctx.push.broadcast` device-push send (any handler kind). */
const isPushSend = (access: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(access)) {
        return false;
    }

    return facadeOf(access.getExpression()) === "push" && PUSH_SEND_METHODS.has(access.getName());
};

/**
 * Discover `ctx.notify` / `ctx.push` sends lexically inside the handler body of
 * every exported `query(...)` / `mutation(...)` registration under the lunora
 * source directory — the `notify_send_outside_action` lint input. `action(...)`
 * (and `stream(...)`) registrations are intentionally skipped: a notification
 * send is external I/O that belongs in actions. One {@link AdvisorNotifyCall} is
 * produced per send site.
 */
const discoverNotifyCalls = (project: Project, lunoraDirectory: string): AdvisorNotifyCall[] => {
    const calls: AdvisorNotifyCall[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const procedure of proceduresInSourceFile(sourceFile)) {
            if (procedure.kind !== "query" && procedure.kind !== "mutation") {
                continue;
            }

            for (const access of procedure.handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
                const callee = notifyCalleeOf(access);

                if (callee !== undefined) {
                    calls.push({ callee, exportName: procedure.exportName, file: relativePath, kind: procedure.kind, line: access.getStartLineNumber() });
                }
            }
        }
    }

    return calls;
};

/** Whether any exported handler (of any kind) performs a `ctx.push` device-push send. */
const projectUsesPush = (project: Project, lunoraDirectory: string): boolean => {
    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const procedure of proceduresInSourceFile(sourceFile)) {
            for (const access of procedure.handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
                if (isPushSend(access)) {
                    return true;
                }
            }
        }
    }

    return false;
};

/** Resolve the `export default` expression, following one `const x = …; export default x` indirection. Mirrors `discoverFlags`. */
const defaultExportExpression = (source: SourceFile): Expression | undefined => {
    const assignment = source.getExportAssignment((declaration) => !declaration.isExportEquals());

    if (!assignment) {
        return undefined;
    }

    const expression = assignment.getExpression();

    if (!Node.isIdentifier(expression)) {
        return expression;
    }

    const declaration = expression.getSymbol()?.getValueDeclaration();

    if (declaration && Node.isVariableDeclaration(declaration)) {
        return declaration.getInitializer();
    }

    return expression;
};

/**
 * Discover which push channels the project's `lunora/notify.ts` default export
 * (`defineNotify({...})`) wires plus whether any handler sends a push — the
 * `notify_missing_push_config` lint input. Returns `undefined` when the file is
 * absent (the app declares no notify config). The read is metadata-only and
 * lenient (like `discoverFlags`): a `webPush`/`fcm` property's mere presence
 * counts as the channel being wired; a non-literal config degrades to "unwired"
 * rather than throwing.
 */
const discoverNotifyConfig = (project: Project, lunoraDirectory: string): AdvisorNotifyConfig | undefined => {
    const notifyPath = join(lunoraDirectory, NOTIFY_FILENAME);

    if (!existsSync(notifyPath)) {
        return undefined;
    }

    const source = project.getSourceFile(notifyPath) ?? project.addSourceFileAtPath(notifyPath);
    const exported = defaultExportExpression(source);

    let hasWebPush = false;
    let hasFcm = false;

    if (exported && Node.isCallExpression(exported)) {
        const argument = exported.getArguments()[0];

        if (argument && Node.isObjectLiteralExpression(argument)) {
            hasWebPush = argument.getProperty("webPush") !== undefined;
            hasFcm = argument.getProperty("fcm") !== undefined;
        }
    }

    return { hasFcm, hasWebPush, usesPush: projectUsesPush(project, lunoraDirectory) };
};

export { discoverNotifyCalls, discoverNotifyConfig, NOTIFY_FILENAME };
