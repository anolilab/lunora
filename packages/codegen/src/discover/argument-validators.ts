import type { CallExpression, ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { ArgumentValidatorIR } from "../ir";
import { procedureArgumentObjects } from "../procedure-argument-objects";
import { listLunoraSourceFiles, lunoraRelativePath, propertyKeyName } from "./ast";
import { exportedNameOf, exportedVariableDeclarationsOf } from "./attribution";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

/**
 * Chain methods that actually bound a string's length.
 *
 * `.meta()` is deliberately absent. It is documented in `@lunora/values` as
 * carrying "pure metadata (description + JSON Schema constraint fragment) with
 * no effect on runtime parsing" — it reuses the parser unchanged — so a
 * `.meta({ schema: { maxLength: 200 } })` is a claim about the emitted schema and
 * nothing the runtime enforces. The text-matching predicate this replaced
 * accepted it, and accepted the bare substrings `length` and `max` anywhere in
 * the initializer besides: a comment, a nested field NAME (`v.object({ maxItems
 * })`), a default string. Every one of those cleared the lint for an argument
 * that is genuinely unbounded.
 *
 * `.check()` stays: it is the escape hatch a length predicate is written through
 * (`v.string().check((s) => s.length <= 200, …)`), and its predicate is a
 * function body this pass cannot read. Accepting it over-clears rather than
 * over-reports, which is the right direction for an advisory lint.
 *
 * Same shape as `admin-routes.ts`'s guard detection, and for the same reason
 * written down there: the path literal and the comments must not be able to
 * false-clear the check.
 */
const BOUNDING_METHODS = new Set(["check", "length", "max"]);

/**
 * Whether a bounding method is applied to `call` — walking the chain
 * (`v.string().min(1).max(200)`) rather than the source text, so only a real
 * method call on this very validator counts.
 */
const isBounded = (call: Node): boolean => {
    let current = call;

    for (;;) {
        const access = current.getParent();

        if (!access || !Node.isPropertyAccessExpression(access) || access.getExpression() !== current) {
            return false;
        }

        const invocation = access.getParent();

        if (!invocation || !Node.isCallExpression(invocation) || invocation.getExpression() !== access) {
            return false;
        }

        if (BOUNDING_METHODS.has(access.getName())) {
            return true;
        }

        current = invocation;
    }
};

/**
 * How a source file refers to the validator namespace. Only the two binding
 * shapes that name it are resolved; an arbitrary identifier is never followed.
 * `namespaces` holds the receiver texts that mean the namespace, and
 * `destructured` maps a local name bound by `const { any } = v` to its factory.
 */
type ValidatorScope = {
    destructured: Map<string, string>;
    namespaces: Set<string>;
};

/** Receiver texts for the namespace: `v` itself, an aliased `v` import, and `ns.v` for a namespace import. */
const namespaceReceiversOf = (sourceFile: SourceFile): Set<string> => {
    const namespaces = new Set<string>(["v"]);

    for (const declaration of sourceFile.getImportDeclarations()) {
        const namespaceImport = declaration.getNamespaceImport();

        if (namespaceImport) {
            namespaces.add(`${namespaceImport.getText()}.v`);
        }

        for (const specifier of declaration.getNamedImports()) {
            if (specifier.getName() === "v") {
                namespaces.add(specifier.getAliasNode()?.getText() ?? "v");
            }
        }
    }

    return namespaces;
};

/** Local names bound by a destructure of a namespace receiver, mapped to the factory each one names. */
const destructuredFactoriesOf = (sourceFile: SourceFile, namespaces: ReadonlySet<string>): Map<string, string> => {
    const destructured = new Map<string, string>();

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const pattern = declaration.getNameNode();
        const initializer = declaration.getInitializer();

        if (!Node.isObjectBindingPattern(pattern) || !initializer || !namespaces.has(initializer.getText())) {
            continue;
        }

        for (const element of pattern.getElements()) {
            if (!element.getDotDotDotToken()) {
                destructured.set(element.getName(), element.getPropertyNameNode()?.getText() ?? element.getName());
            }
        }
    }

    return destructured;
};

const validatorScopeOf = (sourceFile: SourceFile): ValidatorScope => {
    const namespaces = namespaceReceiversOf(sourceFile);

    return { destructured: destructuredFactoriesOf(sourceFile, namespaces), namespaces };
};

/** The `v.<name>(…)` factory a call expression invokes, or `undefined` when it is not one. */
const vFactoryName = (node: Node, scope: ValidatorScope): string | undefined => {
    if (!Node.isCallExpression(node)) {
        return undefined;
    }

    const expression = node.getExpression();

    if (Node.isPropertyAccessExpression(expression)) {
        return scope.namespaces.has(expression.getExpression().getText()) ? expression.getName() : undefined;
    }

    if (Node.isIdentifier(expression)) {
        return scope.destructured.get(expression.getText());
    }

    return undefined;
};

/**
 * The body of a helper declared as a top-level `const` arrow/function or a
 * function declaration in the same file. Imported helpers are not resolved.
 */
const sameFileHelperBody = (callee: Node, sourceFile: SourceFile): Node | undefined => {
    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const name = callee.getText();
    const initializer = sourceFile.getVariableDeclaration(name)?.getInitializer();

    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return initializer;
    }

    return sourceFile.getFunction(name);
};

/** A `v.<name>(…)` factory reached from an arg initializer, and whether a bounding call applies to it. */
type FactoryCall = { bounded: boolean; factory: string };

/**
 * The factory calls in a same-file helper's body, reached through `call`. A
 * bound applied at the call site (`helper().max(200)`) counts for each of them.
 */
const helperFactoryCalls = (call: CallExpression, scope: ValidatorScope): FactoryCall[] => {
    const body = sameFileHelperBody(call.getExpression(), call.getSourceFile());

    if (!body) {
        return [];
    }

    const boundAtSite = isBounded(call);

    return [body, ...body.getDescendants()].flatMap((node) => {
        const factory = vFactoryName(node, scope);

        return factory === undefined ? [] : [{ bounded: boundAtSite || isBounded(node), factory }];
    });
};

/**
 * Every `v.<name>(…)` factory reached from `initializer`, including one it
 * calls directly. A same-file helper contributes the factories in its body.
 * Helpers are followed one level only: a helper called from inside a helper is
 * not entered, so a deeper wrapper still goes unseen.
 */
const vFactoryCalls = (initializer: Node, scope: ValidatorScope): FactoryCall[] =>
    [initializer, ...initializer.getDescendants()].flatMap((node) => {
        const factory = vFactoryName(node, scope);
        const direct = factory === undefined ? [] : [{ bounded: isBounded(node), factory }];

        return Node.isCallExpression(node) ? [...direct, ...helperFactoryCalls(node, scope)] : direct;
    });

/** Classify every arg property across the given object literals into any-typed and unbounded-string buckets. */
const classifyArgs = (objects: ReadonlyArray<ObjectLiteralExpression>, scope: ValidatorScope): { anyArgs: string[]; unboundedStringArgs: string[] } => {
    const anyArgs: string[] = [];
    const unboundedStringArgs: string[] = [];

    for (const object of objects) {
        for (const property of object.getProperties()) {
            if (!Node.isPropertyAssignment(property)) {
                continue;
            }

            const initializer = property.getInitializer();

            if (!initializer) {
                continue;
            }

            const factories = vFactoryCalls(initializer, scope);
            const name = propertyKeyName(property);

            if (factories.some((factory) => factory.factory === "any")) {
                anyArgs.push(name);
            } else if (factories.some((factory) => factory.factory === "string" && !factory.bounded)) {
                unboundedStringArgs.push(name);
            }
        }
    }

    return { anyArgs, unboundedStringArgs };
};

/** Build the {@link ArgumentValidatorIR} for one exported public procedure, or `undefined` when it isn't one (or has no flagged args). */
const argumentValidatorIrFromDeclaration = (declaration: VariableDeclaration, relativePath: string, scope: ValidatorScope): ArgumentValidatorIR | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const classified = classifyProcedureCall(initializer);

    // Only public procedures take untrusted input; internal functions are
    // server-called with already-validated arguments.
    if (classified?.visibility !== "public") {
        return undefined;
    }

    const { objects } = procedureArgumentObjects(initializer, classified.receiver);

    const { anyArgs, unboundedStringArgs } = classifyArgs(objects, scope);

    if (anyArgs.length === 0 && unboundedStringArgs.length === 0) {
        return undefined;
    }

    return {
        anyArgs,
        exportName: exportedNameOf(declaration) ?? declaration.getName(),
        file: relativePath,
        line: initializer.getStartLineNumber(),
        unboundedStringArgs,
    };
};

/** Per-procedure arg-validator snapshots across one source file. */
const argumentValidatorsInSourceFile = (sourceFile: SourceFile, relativePath: string): ArgumentValidatorIR[] => {
    const found: ArgumentValidatorIR[] = [];
    const scope = validatorScopeOf(sourceFile);

    for (const declaration of exportedVariableDeclarationsOf(sourceFile)) {
        const ir = argumentValidatorIrFromDeclaration(declaration, relativePath, scope);

        if (ir) {
            found.push(ir);
        }
    }

    return found;
};

/**
 * Discover, per exported **public** query/mutation/action under the lunora source
 * directory, the argument validators that weaken input safety: `v.any()` args
 * (unvalidated, untyped input — the `public_arg_uses_any` lint) and `v.string()`
 * args with no `.max()`/`.length()`/`.check()` length bound (a DoS /
 * storage-abuse vector — the `unbounded_string_arg` lint). Only procedures with at least one flagged arg
 * are recorded. Internal functions are skipped: they take server-trusted input.
 */
const discoverArgumentValidators = (project: Project, lunoraDirectory: string): ArgumentValidatorIR[] => {
    const procedures: ArgumentValidatorIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        procedures.push(...argumentValidatorsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return procedures;
};

export default discoverArgumentValidators;
