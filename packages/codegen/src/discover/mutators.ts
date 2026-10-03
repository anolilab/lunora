import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
    ArrowFunction,
    CallExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    MethodDeclaration,
    Node as TsNode,
    ObjectLiteralExpression,
    Project,
    SourceFile,
    ts,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { MutatorIR, ValidatorIR } from "../ir";
import { isServerSurfaceModule } from "../module-specifiers";
import { parseObjectShape } from "../parse-validator";
import { findObjectProperty, isConstDeclaration, unwrapExpression } from "./ast";
import { declarationOf, exportedNameOf, exportNamesOfDeclaration, isAddressableExportName } from "./attribution";
import unwrapHandlerReturn from "./functions/unwrap-handler-return";

/** The only file custom mutators may be declared in — mirrors `lunora/queues.ts`. */
const MUTATORS_FILENAME = "mutators.ts";

/**
 * True for any module specifier `defineMutator` may come from. Includes the
 * generated `_generated/server` re-export, which binds `ctx` to this project's
 * typed `MutationCtx` and is therefore the form mutators SHOULD be authored with.
 */
const isMutatorSurfaceModule = isServerSurfaceModule;

/**
 * Decide whether a callee identifier refers to `defineMutator` from
 * `@lunora/server` (its `lunorash/server` umbrella subpath, or the generated
 * `_generated/server` re-export). Mirrors `isDefineQueue`: trust the import
 * declaration when the checker has a symbol (so aliasing survives), and fall back
 * to the surface text when no symbol is available.
 */
const isDefineMutator = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineMutator";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!isMutatorSurfaceModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineMutator";
    }

    return false;
};

/**
 * Decide whether `identifier` is a namespace binding of an allowed mutator
 * module — the `server` in `import * as server from "@lunora/server"`. Used to
 * recognize the member-access callee form `server.defineMutator(...)`.
 */
const isMutatorNamespaceImport = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return false;
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isNamespaceImport(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);

        return importDeclaration !== undefined && isMutatorSurfaceModule(importDeclaration.getModuleSpecifierValue());
    }

    return false;
};

/**
 * Decide whether a call's callee is `defineMutator` — either the bare imported
 * identifier (`defineMutator(...)`) or a namespace member access
 * (`server.defineMutator(...)`). Both are valid ES module syntax, so discovery
 * must see mutators declared either way.
 */
const isDefineMutatorCallee = (callee: TsNode): boolean => {
    if (Node.isIdentifier(callee)) {
        return isDefineMutator(callee);
    }

    if (Node.isPropertyAccessExpression(callee)) {
        const object = callee.getExpression();

        return callee.getName() === "defineMutator" && Node.isIdentifier(object) && isMutatorNamespaceImport(object);
    }

    return false;
};

/**
 * The `{ args, client, server }` object literal a `defineMutator` call was given,
 * or `undefined` when the argument isn't an inline literal (a hoisted definition
 * object — the args/return types then stay unresolved rather than guessed).
 */
const mutatorLiteral = (call: CallExpression): ObjectLiteralExpression | undefined => {
    const first = call.getArguments()[0];

    return first && Node.isObjectLiteralExpression(first) ? first : undefined;
};

/** The function forms a mutator's authoritative `server` impl is statically readable in. */
type MutatorServerImpl = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

/** Per-declaration {@link isReferencedOnce} verdicts, keyed on the compiler node so a re-parse recomputes. */
const REFERENCED_ONCE_CACHE = new WeakMap<ts.Node, boolean>();

/**
 * Whether the top-level binding `declaration` creates is referenced exactly
 * once in its file — by the `server:` member that hands it to `defineMutator`.
 * Any other reference (a second mutator, a direct call, a recursive call) or
 * an export could run the impl with an `args` `applyOwnerScope` never verified.
 */
const isReferencedOnce = (declaration: FunctionDeclaration | VariableDeclaration): boolean => {
    let verdict = REFERENCED_ONCE_CACHE.get(declaration.compilerNode);

    if (verdict === undefined) {
        const nameNode = declaration.getNameNode();
        const name = nameNode?.getText();
        const references = declaration
            .getSourceFile()
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .filter(
                (identifier) =>
                    identifier !== nameNode && identifier.getText() === name && declarationOf(identifier)?.compilerNode === declaration.compilerNode,
            );

        // An exported impl can be imported and called by any other module.
        verdict = references.length === 1 && exportedNameOf(declaration) === undefined;
        REFERENCED_ONCE_CACHE.set(declaration.compilerNode, verdict);
    }

    return verdict;
};

/**
 * The impl a `server: impl` / `{ server }` reference names: a top-level
 * `function` declaration or `const` arrow / function expression of the same
 * file, referenced nowhere but there ({@link isReferencedOnce}).
 */
const referencedServerImplOf = (reference: TsNode | undefined): MutatorServerImpl | undefined => {
    const declaration = Node.isIdentifier(reference) ? declarationOf(reference) : undefined;
    const isTopLevel = Node.isSourceFile(declaration?.getParent()) || Node.isSourceFile(declaration?.getParent()?.getParent()?.getParent());

    if (declaration === undefined || declaration.getSourceFile() !== reference?.getSourceFile() || !isTopLevel) {
        return undefined;
    }

    if (Node.isFunctionDeclaration(declaration)) {
        return declaration.hasBody() && isReferencedOnce(declaration) ? declaration : undefined;
    }

    const initializer = isConstDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : undefined;
    const isFunction = Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer);

    return isFunction && Node.isVariableDeclaration(declaration) && isReferencedOnce(declaration) ? initializer : undefined;
};

/**
 * The `server` impl of the mutator `declaration` binds
 * (`const x = defineMutator({ server })`), resolved DOWN from that declaration
 * so it is always this declaration's own impl, never a same-named nested one.
 * Reads `server: (ctx, args) => …`, `server: function (ctx, args) {…}`, the
 * method shorthand `server(ctx, args) {…}`, and `server: impl` / `{ server }`
 * naming a same-file function used nowhere else ({@link referencedServerImplOf};
 * the runtime wraps `.server` itself, so the mutator is the only way in), seen
 * through `(…)`, `as` and `satisfies`. `undefined` for anything else — an
 * import, an impl also called elsewhere, or a higher-order `server: wrap(fn)`
 * whose wrapper could hand `fn` different arguments — so callers fail closed.
 */
const mutatorServerImplOf = (declaration: VariableDeclaration): MutatorServerImpl | undefined => {
    const call = declaration.getInitializer();

    if (!Node.isCallExpression(call) || !isDefineMutatorCallee(call.getExpression())) {
        return undefined;
    }

    const property = findObjectProperty(mutatorLiteral(call), "server");

    if (Node.isMethodDeclaration(property)) {
        return property;
    }

    if (Node.isShorthandPropertyAssignment(property)) {
        return referencedServerImplOf(property.getNameNode());
    }

    const impl = Node.isPropertyAssignment(property) ? unwrapExpression(property.getInitializer()) : undefined;

    return Node.isArrowFunction(impl) || Node.isFunctionExpression(impl) ? impl : referencedServerImplOf(impl);
};

/**
 * The mutator's `args` validator map, parsed with the same `parseObjectShape` a
 * procedure's `args` goes through so `api.mutators.<name>` and `api.<file>.<fn>`
 * can never render a validator differently. `{}` when `args` is absent (a
 * parameterless mutator) or isn't an inline object literal.
 */
const argsFromMutator = (literal: ObjectLiteralExpression | undefined): Record<string, ValidatorIR> => {
    const argsProperty = findObjectProperty(literal, "args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    return initializer && Node.isObjectLiteralExpression(initializer) ? parseObjectShape(initializer) : {};
};

/**
 * The authoritative `server` impl's return type, `Promise<…>` unwrapped — the
 * `Return` of the emitted `api.mutators.<name>` reference, so `ctx.runMutation`
 * on it (and a `useMutation` over it) resolves the real result instead of
 * `unknown`. `"unknown"` when `server` isn't an inline function.
 */
const returnTypeFromMutator = (literal: ObjectLiteralExpression | undefined): string => {
    const serverProperty = findObjectProperty(literal, "server");

    if (!serverProperty || !Node.isPropertyAssignment(serverProperty)) {
        return "unknown";
    }

    const initializer = serverProperty.getInitializer();

    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return "unknown";
    }

    return unwrapHandlerReturn(initializer);
};

/**
 * The ownership column a `defineMutator({ owner: "…" })` declares, or `undefined`
 * when it declares none (or names it with something other than a string literal —
 * a computed value cannot be resolved here, and guessing would both suppress a
 * real `owner_field_from_args_not_auth` finding and fake a clean owner scope).
 */
const ownerFromMutator = (literal: ObjectLiteralExpression | undefined): string | undefined => {
    const property = findObjectProperty(literal, "owner");

    if (!property || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined;
};

/** Collect exported `defineMutator` declarations from one source file. */
const mutatorsFromSource = (source: SourceFile): MutatorIR[] => {
    const mutators: MutatorIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const call = initializer as CallExpression;
        const callee = call.getExpression();

        if (!isDefineMutatorCallee(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineMutator exports must be plain named exports (no destructuring)");
        }

        const literal = mutatorLiteral(call);

        // Under every name the module exports it as; the dispatch table reads it off the namespace by name.
        for (const exportName of exportNamesOfDeclaration(declaration).filter((name) => isAddressableExportName(name))) {
            mutators.push({
                args: argsFromMutator(literal),
                exportName,
                filePath: "mutators",
                line: call.getStartLineNumber(),
                owner: ownerFromMutator(literal),
                returnType: returnTypeFromMutator(literal),
            });
        }
    }

    return mutators;
};

/**
 * Discover every custom mutator the project declares: exported
 * `defineMutator()` calls in `lunora/mutators.ts`. Returns `[]` when the file
 * doesn't exist. The export binding plus the declared `args` / `server` return
 * type are lifted — enough to emit a typed `api.mutators.<name>` reference —
 * while the runtime object still carries the authoritative `server` impl +
 * `handler`, so codegen never evaluates the body. The client `client` impl is
 * split into the browser bundle separately.
 */
const discoverMutators = (project: Project, lunoraDirectory: string): MutatorIR[] => {
    const mutatorsPath = join(lunoraDirectory, MUTATORS_FILENAME);

    if (!existsSync(mutatorsPath)) {
        return [];
    }

    const source = project.getSourceFile(mutatorsPath) ?? project.addSourceFileAtPath(mutatorsPath);
    const mutators = mutatorsFromSource(source);

    mutators.sort((a, b) => a.exportName.localeCompare(b.exportName));

    return mutators;
};

export { discoverMutators, isDefineMutatorCallee, mutatorLiteral, MUTATORS_FILENAME, mutatorServerImplOf };
export type { MutatorServerImpl };
