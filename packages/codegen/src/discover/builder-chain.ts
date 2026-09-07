import type { CallExpression, Node } from "ts-morph";
import { Node as TsNode } from "ts-morph";

import { unwrapExpression } from "./ast";
import { resolvesToImportedName } from "./callee";

/** One `.method(...)` step of a builder chain, in terminal-to-root order. */
interface BuilderChainStep {
    /** The step call itself — `.use(rls(p))`, `.input({...})`, `.output(v)`. */
    call: CallExpression;
    /** The step's method name. */
    name: string;
}

/**
 * Walk a builder chain leftward from `receiver`, collecting each `.method(...)`
 * step and the expression the chain bottoms out at.
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

    while (current && TsNode.isCallExpression(current)) {
        const callee = unwrapExpression(current.getExpression());

        if (!callee || !TsNode.isPropertyAccessExpression(callee)) {
            return { root: undefined, steps };
        }

        steps.push({ call: current, name: callee.getName() });
        current = unwrapExpression(callee.getExpression());
    }

    return { root: current, steps };
};

/** The `.method(...)` steps of a builder chain, terminal-first. */
const builderChainSteps = (receiver: Node): BuilderChainStep[] => walkBuilderChain(receiver).steps;

/**
 * The first argument of every `<method>(<callee>(...))` step in the chain — the
 * shape `.use(rls(...))` / `.use(mask(...))` take. `callee` is matched through
 * {@link resolvesToImportedName}, so an import alias counts.
 */
const wrappedCallsInChain = (receiver: Node, method: string, callee: string): CallExpression[] =>
    builderChainSteps(receiver)
        .filter((step) => step.name === method)
        .map((step) => step.call.getArguments()[0])
        .filter(
            (argument): argument is CallExpression =>
                argument !== undefined && TsNode.isCallExpression(argument) && resolvesToImportedName(argument.getExpression(), callee),
        );

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

export { builderChainSteps, chainHasStep, chainUsesWrappedCall, walkBuilderChain, wrappedCallsInChain };
