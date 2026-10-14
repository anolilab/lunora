import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AdvisorNotifyCall, AdvisorNotifyConfig } from "@lunora/advisor";
import type { CallExpression, Expression, Identifier, Node as TsNode, ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { defaultExportExpression, findObjectProperty, handlerOf, listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { exportedNameOf, exportedVariableDeclarationsOf } from "./attribution";
import { isContextSurface } from "./context-root";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

/** The only file a `@lunora/notify` provider may be declared in — mirrors `lunora/flags.ts`. */
const NOTIFY_FILENAME = "notify.ts";

/** `ctx.notify.<method>` sends the `notify_send_outside_action` lint records (single-channel + multi-channel senders). */
const NOTIFY_SEND_METHODS = new Set(["chat", "inApp", "send", "webhook"]);

/** `ctx.push.<method>` sends the lint records — the two device-push delivery calls (register/list/unregister are store ops, not sends). */
const PUSH_SEND_METHODS = new Set(["broadcast", "send"]);

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

    return handler ? { exportName: exportedNameOf(declaration) ?? declaration.getName(), handler, kind: classified.kind } : undefined;
};

/** Every exported procedure handler in one source file. */
const proceduresInSourceFile = (sourceFile: SourceFile): ResolvedProcedure[] => {
    const found: ResolvedProcedure[] = [];

    for (const declaration of exportedVariableDeclarationsOf(sourceFile)) {
        const procedure = exportedProcedureHandler(declaration);

        if (procedure) {
            found.push(procedure);
        }
    }

    return found;
};

/**
 * Resolve a `ctx.notify` / `ctx.push` / `ctx.notify.push` receiver to its
 * facade label, or `undefined` when the node isn't one. Resolved by symbol
 * through the shared ctx resolver, so a renamed ctx (`c.notify`), a
 * destructured `const { notify } = ctx` and a `const` alias resolve too.
 */
const facadeOf = (node: TsNode): "notify" | "push" | undefined => {
    if (isContextSurface(node, ["notify"])) {
        return "notify";
    }

    return isContextSurface(node, ["push"]) || isContextSurface(node, ["notify", "push"]) ? "push" : undefined;
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

/** Which push channels `lunora/notify.ts` wires. */
interface NotifyChannels {
    hasFcm: boolean;
    hasWebPush: boolean;
}

/**
 * The specifier that exports the `defineNotify` config factory: the granular
 * `@lunora/notify` package. Unlike `ctx.flags`, the umbrella never re-exports
 * notify's surface (`shard-bindings.ts`), so there is no umbrella variant to
 * accept.
 */
const DEFINE_NOTIFY_MODULES = new Set(["@lunora/notify"]);

/**
 * Decide whether a callee identifier refers to `defineNotify` from one of
 * {@link DEFINE_NOTIFY_MODULES}. Mirrors `isFlagshipProvider` (`flags.ts`):
 * trust the import declaration when the symbol resolves, and a bare same-named
 * identifier when the ts-morph project can't always resolve the workspace
 * package. Anything else — a local wrapper factory around `defineNotify` — is
 * NOT `defineNotify`: its argument must not be read as the complete config.
 */
const isDefineNotify = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineNotify";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!DEFINE_NOTIFY_MODULES.has(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineNotify";
    }

    return false;
};

/**
 * The default-export expression of the notify config, following a re-export
 * chain to the file that actually declares it. `defaultExportExpression` already
 * resolves a same-file `const` alias; this additionally resolves an identifier
 * that re-exports the default of a sibling lunora file
 * (`import definition from "./notify-definition"; export default definition;`)
 * by following its aliased symbol to that file's `ExportAssignment`. Returns
 * `undefined` for a re-export cycle so the caller's conservative fallback
 * applies.
 */
const notifyConfigExpression = (source: SourceFile, visiting: Set<string> = new Set()): Expression | undefined => {
    const exported = defaultExportExpression(source);

    if (!exported) {
        return undefined;
    }

    if (!Node.isIdentifier(exported)) {
        return exported;
    }

    const symbol = exported.getSymbol();

    if (!symbol?.isAlias()) {
        return exported;
    }

    const aliased = symbol.getAliasedSymbol();

    if (!aliased) {
        return exported;
    }

    const assignment = aliased.getDeclarations().find((declaration) => Node.isExportAssignment(declaration));

    if (!assignment) {
        return exported;
    }

    const target = assignment.getSourceFile();

    if (visiting.has(target.getFilePath())) {
        return undefined;
    }

    return notifyConfigExpression(target, visiting.add(target.getFilePath()));
};

/** Assignment operators that write through a property/element of the binding. */
const WRITE_OPERATORS = new Set(["%=", "&&=", "&=", "**=", "+=", "-=", "/=", "<<=", "=", ">>=", ">>>=", "??=", "^=", "|=", "||="]);

/** The node that declares the binding an identifier refers to, following import aliases. */
const bindingDeclarationOf = (identifier: Identifier): TsNode | undefined => {
    const symbol = identifier.getSymbol();

    return symbol?.getAliasedSymbol()?.getDeclarations()[0] ?? symbol?.getDeclarations()[0];
};

/** The identifier a write operand mutates through, unwrapping `config.fcm`/`config["fcm"]` to `config`. */
const mutatedIdentifierOf = (node: TsNode): Identifier | undefined => {
    if (Node.isIdentifier(node)) {
        return node;
    }

    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
        return mutatedIdentifierOf(node.getExpression());
    }

    return undefined;
};

/** True when `operand` is a write through the binding `declaration` (its root identifier resolves to it). */
const writesThrough = (operand: TsNode, declaration: TsNode): boolean => {
    const target = mutatedIdentifierOf(operand);

    return target !== undefined && bindingDeclarationOf(target) === declaration;
};

/** True when `call` is an `Object.assign`-family (`Object.defineProperty(s)`/`Reflect.set`) mutation of `declaration`. */
const assignCallMutates = (call: CallExpression, declaration: TsNode): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return false;
    }

    const name = callee.getName();
    const object = callee.getExpression();
    const objectName = Node.isIdentifier(object) ? object.getText() : "";
    const mutates =
        ((name === "assign" || name === "defineProperty" || name === "defineProperties") && objectName === "Object") ||
        (name === "set" && objectName === "Reflect");

    if (!mutates) {
        return false;
    }

    const target = call.getArguments()[0];

    return target !== undefined && Node.isIdentifier(target) && bindingDeclarationOf(target) === declaration;
};

/** True when `node` writes through the binding `declaration` (assignment, delete, update, or Object.assign-family call). */
const mutatedBy = (node: TsNode, declaration: TsNode): boolean => {
    if (Node.isBinaryExpression(node)) {
        return WRITE_OPERATORS.has(node.getOperatorToken().getText()) && writesThrough(node.getLeft(), declaration);
    }

    if (Node.isDeleteExpression(node)) {
        return writesThrough(node.getExpression(), declaration);
    }

    if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
        const operator = node.getOperatorToken();

        return (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken) && writesThrough(node.getOperand(), declaration);
    }

    if (Node.isCallExpression(node)) {
        return assignCallMutates(node, declaration);
    }

    return false;
};

/**
 * True when the binding `identifier` refers to is written to anywhere in `files`
 * (`Object.assign`/`Object.defineProperty`/`Object.defineProperties`/`Reflect.set`
 * with the binding as target, a property/element assignment, `delete`, or
 * `++`/`--`). `const config = { webPush }; Object.assign(config, { fcm })` —
 * or `config.fcm = ...` — mutates the object without changing its initializer,
 * so the initializer is not the configuration `defineNotify(config)` receives.
 * The scan is bounded to the declaring and using files; mutation through an
 * opaque helper call is not statically trackable and stays a documented gap.
 */
const bindingIsMutated = (identifier: Identifier, files: SourceFile[]): boolean => {
    const declaration = bindingDeclarationOf(identifier);

    if (declaration === undefined) {
        return true;
    }

    return files.some((file) => file.getDescendants().some((descendant) => mutatedBy(descendant, declaration)));
};

/**
 * The object-literal config a `defineNotify(...)` argument refers to: the
 * argument itself, or the literal initializer of the variable/import it names
 * (`const config = { webPush: ... }; defineNotify(config)`, including a config
 * imported from a sibling lunora file). Mirrors `resolveStringConst` in
 * `inserts.ts` — follows the symbol's (aliased) declaration to an object-literal
 * initializer. Returns `undefined` when the argument is a call result, an
 * unreadable property access, or otherwise not a statically-readable literal;
 * the caller's spread rejection and both-channels fallback then apply, because
 * such a config may still wire a channel. A variable/import initializer is only
 * trusted when it is established as fixed — a `const` binding that is never
 * written to in its declaring file or the calling file — because
 * `Object.assign(config, { fcm })` or `config.fcm = ...` before the call makes
 * the initializer no longer the configuration `defineNotify` receives.
 */
const configLiteralOf = (argument: TsNode): ObjectLiteralExpression | undefined => {
    if (Node.isObjectLiteralExpression(argument)) {
        return argument;
    }

    if (!Node.isIdentifier(argument)) {
        return undefined;
    }

    const symbol = argument.getSymbol();
    const declarations = symbol?.getAliasedSymbol()?.getDeclarations() ?? symbol?.getDeclarations() ?? [];

    for (const declaration of declarations) {
        if (!Node.isVariableDeclaration(declaration)) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
            continue;
        }

        const declarationList = declaration.getParent();

        if (!Node.isVariableDeclarationList(declarationList) || declarationList.getDeclarationKind() !== VariableDeclarationKind.Const) {
            continue;
        }

        const files = [declaration.getSourceFile(), argument.getSourceFile()].filter(
            (file, index, all) => all.findIndex((other) => other.getFilePath() === file.getFilePath()) === index,
        );

        if (bindingIsMutated(argument, files)) {
            continue;
        }

        return initializer;
    }

    return undefined;
};

/**
 * Read which push channels the project's `lunora/notify.ts` default export
 * (`defineNotify({...})`) wires, or `undefined` when the file is absent (the app
 * declares no notify config). The read is metadata-only (like `discoverFlags`):
 * a `webPush`/`fcm` property's mere presence counts as the channel being wired.
 * The argument is read as the complete config only when the callee resolves to
 * `defineNotify` itself (`isDefineNotify`) — a wrapper factory could add a
 * channel before returning a valid definition, so its literal argument is not
 * trustworthy. A same-file `const` alias, a cross-file default re-export, and a
 * variable or imported config that resolves to an object literal
 * (`configLiteralOf`) are followed and read the same way; anything unreadable —
 * no `defineNotify(...)` default export, a non-`defineNotify` callee, a
 * computed/non-literal config, or a spread — reports BOTH channels, so their
 * secrets are scaffolded and preflighted rather than silently dropped (a
 * wrapper factory may add a channel its argument doesn't show). `@lunora/config`
 * reads this alone to scaffold only the configured channels' secrets.
 */
const discoverNotifyChannels = (project: Project, lunoraDirectory: string): NotifyChannels | undefined => {
    const notifyPath = join(lunoraDirectory, NOTIFY_FILENAME);

    if (!existsSync(notifyPath)) {
        return undefined;
    }

    const source = project.getSourceFile(notifyPath) ?? project.addSourceFileAtPath(notifyPath);
    const exported = notifyConfigExpression(source);

    if (!exported || !Node.isCallExpression(exported)) {
        return { hasFcm: true, hasWebPush: true };
    }

    const callee = exported.getExpression();
    const argument = Node.isIdentifier(callee) && isDefineNotify(callee) ? exported.getArguments()[0] : undefined;
    const config = argument === undefined ? undefined : configLiteralOf(argument);

    if (!config || config.getProperties().some((property) => Node.isSpreadAssignment(property))) {
        return { hasFcm: true, hasWebPush: true };
    }

    return { hasFcm: findObjectProperty(config, "fcm") !== undefined, hasWebPush: findObjectProperty(config, "webPush") !== undefined };
};

/**
 * The channels {@link discoverNotifyChannels} reads, plus whether any handler sends a push — the
 * `notify_missing_push_config` lint input. `undefined` when `lunora/notify.ts`
 * is absent.
 */
const discoverNotifyConfig = (project: Project, lunoraDirectory: string): AdvisorNotifyConfig | undefined => {
    const channels = discoverNotifyChannels(project, lunoraDirectory);

    return channels === undefined ? undefined : { ...channels, usesPush: projectUsesPush(project, lunoraDirectory) };
};

export type { NotifyChannels };
export { discoverNotifyCalls, discoverNotifyChannels, discoverNotifyConfig, NOTIFY_FILENAME };
