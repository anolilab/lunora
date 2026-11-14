import type { CallExpression, Node } from "ts-morph";
import { Node as TsNode } from "ts-morph";

import { isConstDeclaration, symbolConstInitializer, unwrapExpression } from "./ast";
import { resolvesToImportedName } from "./callee";

/** One `.method(...)` step of a builder chain, in terminal-to-root order. */
interface BuilderChainStep {
    /** The step call itself — `.use(rls(p))`, `.input({...})`, `.output(v)`. */
    call: CallExpression;
    /** The step's method name. */
    name: string;
}

/** How many same-file `const` builders the walk follows before it stops at an identifier. */
const MAX_CONST_BUILDER_HOPS = 3;

/**
 * The call a root identifier is bound to by a same-file `const`, when that call
 * is itself a builder expression — `const base = mutation.use(x)` read from
 * `base.mutation(h)`. A `let`, an import or a non-call initializer is not followed.
 */
const constBuilderInitializer = (root: Node | undefined): CallExpression | undefined => {
    if (!root || !TsNode.isIdentifier(root)) {
        return undefined;
    }

    const declaration = root.getSymbol()?.getValueDeclaration();

    if (!isConstDeclaration(declaration)) {
        return undefined;
    }

    const initializer = unwrapExpression(declaration.getInitializer());

    return initializer && TsNode.isCallExpression(initializer) ? initializer : undefined;
};

/**
 * Walk a builder chain leftward from `receiver`, collecting each `.method(...)`
 * step and the expression the chain bottoms out at. A root bound to a `const`
 * builder is followed, up to three hops, so `const base = mutation.use(x); base.mutation(h)`
 * carries `x`.
 *
 * This walk was written out longhand in eight places, in three dialects that
 * disagreed about whether to unwrap `(x)` / `x as T` and about what a
 * non-property-access callee means — so a cast mid-chain was invisible to some
 * callers and fatal to others, and a fix applied to one dialect left the rest
 * drifting. One walk, one unwrapping policy, one termination policy.
 *
 * Steps come back TERMINAL-FIRST (the order the chain reads leftward), which is
 * what the "last one written wins" rules downstream depend on: the first
 * `.output()` seen is the last one authored.
 *
 * `root` is the non-call expression the chain ends at, or `undefined` when a
 * step's callee was not a property access. Collapsing those two cases is safe —
 * every caller only ever asks whether `root` is a specific identifier, and a
 * half-walked chain never yields one.
 */
const walkBuilderChain = (receiver: Node): { root: Node | undefined; steps: BuilderChainStep[] } => {
    const steps: BuilderChainStep[] = [];
    let current: Node | undefined = unwrapExpression(receiver);
    let hops = 0;

    for (;;) {
        while (current && TsNode.isCallExpression(current)) {
            const callee = unwrapExpression(current.getExpression());

            if (!callee || !TsNode.isPropertyAccessExpression(callee)) {
                return { root: undefined, steps };
            }

            steps.push({ call: current, name: callee.getName() });
            current = unwrapExpression(callee.getExpression());
        }

        const bound = hops < MAX_CONST_BUILDER_HOPS ? constBuilderInitializer(current) : undefined;

        if (!bound) {
            return { root: current, steps };
        }

        hops += 1;
        current = bound;
    }
};

/** The `.method(...)` steps of a builder chain, terminal-first. */
const builderChainSteps = (receiver: Node): BuilderChainStep[] => walkBuilderChain(receiver).steps;

/**
 * Resolve a `.use(...)` argument to the middleware-factory call it ultimately
 * installs. A direct `.use(rateLimit(...))` is already that call; a `.use(mw)`
 * alias — `const mw = rateLimit(limiter, "bucket", …)` then `.use(mw)`, the shape
 * the storage/presence templates use — resolves through the local `const`'s
 * initializer. Resolution is by NAME within the same file (no cross-file/type
 * info), matching the feeder's name-based philosophy; an alias defined elsewhere
 * (import) or initialised by something other than a call returns `undefined`, so
 * the lint stays fail-closed.
 */
const resolveUseArgumentCall = (argument: Node): CallExpression | undefined => {
    if (TsNode.isCallExpression(argument)) {
        return argument;
    }

    if (!TsNode.isIdentifier(argument)) {
        return undefined;
    }

    // Through the identifier's own binding, and only a module `const`: a `let` can be rebound
    // after its initializer ran, and a same-named local can shadow the module binding.
    const initializer = unwrapExpression(symbolConstInitializer(argument.getSymbol()));

    return initializer && TsNode.isCallExpression(initializer) ? initializer : undefined;
};

/**
 * The first argument of every `<method>(<callee>(...))` step whose callee
 * `matches`, with a `const`-aliased argument (`const r = rls(p); .use(r)`) resolved
 * to its factory call. The walk and the argument rule are shared; only the question
 * asked of the callee varies, so each caller states its own trust policy: middleware
 * detectors use `resolvesToImportedName`, the security markers use `isServerImport`.
 */
const wrappedCallsWhere = (receiver: Node, method: string, matches: (callee: Node) => boolean): CallExpression[] =>
    builderChainSteps(receiver)
        .filter((step) => step.name === method)
        .map((step) => step.call.getArguments()[0])
        .map((argument) => (argument === undefined ? undefined : resolveUseArgumentCall(argument)))
        .filter((call): call is CallExpression => call !== undefined && matches(call.getExpression()));

/**
 * The first argument of every `<method>(<callee>(...))` step in the chain — the
 * shape `.use(rls(...))` / `.use(mask(...))` take. `callee` is matched through
 * {@link resolvesToImportedName}, so an import alias counts.
 */
const wrappedCallsInChain = (receiver: Node, method: string, callee: string): CallExpression[] =>
    wrappedCallsWhere(receiver, method, (candidate) => resolvesToImportedName(candidate, callee));

/** True when the builder chain rooted at `receiver` carries a step whose method name is `method` (`.output(...)` / `.use(...)`). */
const chainHasStep = (receiver: TsNode, method: string): boolean => builderChainSteps(receiver).some((step) => step.name === method);

/**
 * True when the builder chain rooted at `receiver` carries a
 * `.<method>(<wrappedCallee>(...))` step — e.g. `.use(mask(...))` or `.use(rls(...))`.
 *
 * Shares `wrappedCallsInChain` with `rlsCallsInChain` / `maskCallsInChain` so all
 * three answer the same question the same way. They had drifted: those two
 * resolved an import alias and this one compared callee text, so under
 * `import { rls as rowLevel }` a procedure read `usesRls: true` to
 * `discoverRlsProcedures` and `usesRls: false` to the feeders built on this.
 */
const chainUsesWrappedCall = (receiver: TsNode, method: string, wrappedCallee: string): boolean =>
    wrappedCallsInChain(receiver, method, wrappedCallee).length > 0;

export { builderChainSteps, chainHasStep, chainUsesWrappedCall, resolveUseArgumentCall, walkBuilderChain, wrappedCallsInChain, wrappedCallsWhere };
