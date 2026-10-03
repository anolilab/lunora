/**
 * Whether a mutator `server` impl's `args` parameter is still exactly the
 * object `applyOwnerScope` verified.
 */
import type { CallExpression, Identifier, ParameterDeclaration, SourceFile, ts, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isWriteTarget } from "../ast";
import { declarationOf, exportedNameOf } from "../attribution";
import type { MutatorServerImpl } from "../mutators";
import { mutatorServerImplOf } from "../mutators";
import { isReadOnlyUse } from "./read-only-use";

/**
 * The mutator `server` impl `call` runs in, plus its own `ctx` and `args`
 * parameters. `pristine` says whether `args` is still exactly the object
 * `applyOwnerScope` verified (see {@link isPristineArgsParameter}).
 */
interface MutatorImplScope {
    context: ParameterDeclaration | undefined;
    impl: MutatorServerImpl;
    /** The name the mutator is exported (and its `owner` declared) under. */
    mutatorName: string;
    parameter: ParameterDeclaration | undefined;
    pristine: boolean;
}

/** Per-impl {@link isPristineArgsParameter} verdicts, keyed on the compiler node so a re-parse recomputes. */
const PRISTINE_CACHE = new WeakMap<ts.Node, boolean>();

/**
 * Whether the impl can reach its own body again with an `args` that never went
 * through `applyOwnerScope`. Fails closed on any of:
 *
 * - a named function-expression impl referencing its own name (`impl(ctx, forged)`
 * calls the raw function);
 * - a method or function-expression impl using `this` anywhere (an arrow impl has
 * no `this` of its own);
 * - the impl referencing the mutator binding it is declared in
 * (`createPost.server(ctx, forged)`), by symbol.
 *
 * The runtime wraps the exposed `server` in the same validation and owner scope
 * as `handler` and calls the raw impl with that wrapper as `this`, so the last
 * two are defense in depth.
 */
const canReenterUnverified = (impl: MutatorServerImpl, mutatorDeclaration: VariableDeclaration): boolean => {
    const ownName = Node.isFunctionExpression(impl) ? impl.getNameNode() : undefined;

    if (!Node.isArrowFunction(impl) && impl.getFirstDescendantByKind(SyntaxKind.ThisKeyword) !== undefined) {
        return true;
    }

    const names = new Set([mutatorDeclaration.getName(), ...(ownName === undefined ? [] : [ownName.getText()])]);

    return impl.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => {
        if (identifier === ownName || !names.has(identifier.getText())) {
            return false;
        }

        const target = declarationOf(identifier)?.compilerNode;

        return target !== undefined && (target === mutatorDeclaration.compilerNode || (ownName !== undefined && target === impl.compilerNode));
    });
};

/**
 * Whether the impl's `args` parameter is still exactly the object
 * `applyOwnerScope` verified, for every read of it in the impl. Fails closed:
 *
 * - the impl can re-enter itself unverified (see {@link canReenterUnverified});
 * - `arguments` anywhere in the impl reaches the parameter without naming it;
 * - a `var` redeclaration of a parameter binding is a second declaration of it;
 * - an `args` parameter used other than as {@link isReadOnlyUse} allows (a
 * member read, a destructuring initializer, a copy, a read-only call argument,
 * an argument to a same-file function that only reads it such as a local
 * `assertValid(args)`, or a type position): written through, passed to another
 * call (`fix(args)`, an imported validator, `Object.assign(args, …)`), aliased
 * (`const a = args`), or read for an accessor-defining member (`__defineGetter__`), it may be
 * changed where this cannot see;
 * - a destructured binding of the parameter that is written (`userId = …`).
 */
const isPristineArgsParameter = (
    scope: Omit<MutatorImplScope, "pristine">,
    parameter: ParameterDeclaration,
    mutatorDeclaration: VariableDeclaration,
): boolean => {
    const { context, impl } = scope;
    const cached = PRISTINE_CACHE.get(impl.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const nameNode = parameter.getNameNode();
    const bindings = Node.isIdentifier(nameNode)
        ? [nameNode]
        : nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((element) => {
              const name = element.getNameNode();

              return Node.isIdentifier(name) ? [name] : [];
          });
    const declarationByName = new Map(bindings.map((binding) => [binding.getText(), binding.getParentOrThrow().compilerNode]));
    // The same read-only rule as a validator's parameter; a destructured binding only must not be written.
    const isAllowedUse = (reference: Identifier): boolean => (Node.isIdentifier(nameNode) ? isReadOnlyUse(reference, context) : !isWriteTarget(reference));
    const pristine =
        !canReenterUnverified(impl, mutatorDeclaration) &&
        bindings.every((binding) => (binding.getSymbol()?.getDeclarations().length ?? 0) === 1) &&
        impl.getDescendantsOfKind(SyntaxKind.Identifier).every((identifier) => {
            const name = identifier.getText();

            if (name === "arguments") {
                return false;
            }

            const binding = declarationByName.get(name);

            if (binding === undefined || bindings.includes(identifier) || declarationOf(identifier)?.compilerNode !== binding) {
                return true;
            }

            return isAllowedUse(identifier);
        });

    PRISTINE_CACHE.set(impl.compilerNode, pristine);

    return pristine;
};

/** Per-file map from each top-level mutator's `server` impl to the mutator declaring it. */
const IMPLS_BY_FILE = new WeakMap<ts.SourceFile, ReadonlyMap<ts.Node, VariableDeclaration>>();

/** The `server` impls of the file's top-level mutators (see {@link mutatorServerImplOf}), mapped to their mutator. */
const mutatorImplsOf = (sourceFile: SourceFile): ReadonlyMap<ts.Node, VariableDeclaration> => {
    let impls = IMPLS_BY_FILE.get(sourceFile.compilerNode);

    if (impls === undefined) {
        impls = new Map(
            sourceFile.getVariableDeclarations().flatMap((declaration) => {
                const impl = mutatorServerImplOf(declaration);

                return impl === undefined ? [] : [[impl.compilerNode, declaration] as const];
            }),
        );
        IMPLS_BY_FILE.set(sourceFile.compilerNode, impls);
    }

    return impls;
};

/**
 * The {@link MutatorImplScope} of `call`: the `server` impl of a top-level
 * mutator that `call` sits in — inline (`server: (ctx, args) => …`) or
 * declared on its own (`server: impl`) — or `undefined`. Resolved DOWN from
 * each top-level mutator to its own impl, never matched by name on an
 * ancestor: a nested `const save = defineMutator(…)` inside the exported
 * `save` resolves to the export's impl, in which the nested mutator's `args` is
 * just a nested function's parameter.
 */
const mutatorImplScopeOf = (call: CallExpression): MutatorImplScope | undefined => {
    const impls = mutatorImplsOf(call.getSourceFile());
    const impl = call.getAncestors().find((ancestor) => impls.has(ancestor.compilerNode)) as MutatorServerImpl | undefined;
    const declaration = impl === undefined ? undefined : impls.get(impl.compilerNode);

    if (impl === undefined || declaration === undefined) {
        return undefined;
    }

    const [context, candidate] = impl.getParameters();
    const parameter = candidate === undefined || candidate.isRestParameter() ? undefined : candidate;
    const scope = { context, impl, mutatorName: exportedNameOf(declaration) ?? declaration.getName(), parameter };

    return { ...scope, pristine: parameter !== undefined && isPristineArgsParameter(scope, parameter, declaration) };
};

export { isPristineArgsParameter, mutatorImplScopeOf };
export type { MutatorImplScope };
