import type { CallExpression, Identifier } from "ts-morph";
import { Node } from "ts-morph";

import { unwrapExpression } from "../ast";
import { walkBuilderChain } from "../builder-chain";
import { resolveCalleeKind } from "../callee";

const FUNCTION_KINDS = new Set(["action", "mutation", "query", "stream"]);

/**
 * Internal factory names exported from `@lunora/server`, mapped to the kind
 * they register. A call to one of these marks the function `internal`: callable
 * server-side via `ctx.run*` but absent from the client-facing `api`.
 */
const INTERNAL_FACTORIES: Record<string, "action" | "mutation" | "query"> = {
    internalAction: "action",
    internalMutation: "mutation",
    internalQuery: "query",
};

/**
 * Lifecycle factory names exported from `@lunora/server`, mapped to the moment
 * they fire on. A call to one of these registers an internal mutation tagged
 * with its `lifecycle` so emit collects it into the `LUNORA_LIFECYCLE_HOOKS`
 * manifest: `connect`/`disconnect` are dispatched per socket, `init` once per
 * Durable Object instance before any handler runs, and `reactor` after each
 * write flush whose tables the reactor's watched read touched.
 */
type LifecycleMoment = "connect" | "disconnect" | "init" | "reactor";

const LIFECYCLE_FACTORIES: Record<string, LifecycleMoment> = {
    onConnect: "connect",
    onDisconnect: "disconnect",
    onQueryChange: "reactor",
    onShardInit: "init",
};

/**
 * Walk a builder chain leftward to the identifier it roots at, or `undefined`
 * when some step isn't a `.method(...)` call on something.
 *
 * Unwraps at every hop: a `(…)` / `as T` / `satisfies T` / `!` anywhere along
 * the chain is not a builder step, and treating one as the end of the walk
 * dropped the whole procedure from `LUNORA_FUNCTIONS`, not merely its
 * middleware — while codegen still exited `ok`.
 */
const builderChainRoot = (receiver: Node): Identifier | undefined => {
    const { root } = walkBuilderChain(receiver);

    return root && Node.isIdentifier(root) ? root : undefined;
};

/**
 * Resolve a builder-terminal chain's root identifier (`query`/`mutation`/...) to
 * its visibility, via {@link builderChainRoot} then {@link resolveCalleeKind}.
 * Returns `"public"` / `"internal"` for a Lunora builder root, or `undefined`
 * when the chain doesn't root at one (so an unrelated `obj.query(...)` method call
 * isn't mistaken for a registration). Import-name based, so it doesn't depend on
 * the `@lunora/server` types being installed/resolvable.
 */
const resolveBuilderRootKind = (receiver: Node, followedLocal = false): "internal" | "public" | undefined => {
    const root = builderChainRoot(receiver);

    if (!root) {
        return undefined;
    }

    const rootName = resolveCalleeKind(root);

    if (rootName === undefined) {
        // The root identifier didn't resolve to an imported Lunora factory. It
        // may instead be a LOCAL const bound to a partially-applied builder
        // (`const b = mutation.input({...}); export const x = b.mutation(...)`).
        // Follow the const's initializer ONE hop and re-resolve, so the chain
        // is still discovered under degraded types (where the `__lunoraProcedure`
        // brand can't resolve). Bounded to a single hop so a `const a = b; const
        // b = a;` cycle can't loop.
        if (followedLocal) {
            return undefined;
        }

        const declaration = root.getSymbol()?.getValueDeclaration();

        if (declaration && Node.isVariableDeclaration(declaration)) {
            const initializer = declaration.getInitializer();

            return initializer ? resolveBuilderRootKind(initializer, true) : undefined;
        }

        return undefined;
    }

    if (FUNCTION_KINDS.has(rootName)) {
        return "public";
    }

    return INTERNAL_FACTORIES[rootName] ? "internal" : undefined;
};

/** Procedure classification — kind + visibility — produced by {@link classifyProcedureCall}. */
interface ProcedureClassification {
    /** Registration kind: `query` | `mutation` | `action` | `stream`. */
    kind: string;

    /**
     * Set when the call is a connection-lifecycle hook (`onConnect`/`onDisconnect`):
     * the socket side it fires on. The classification is otherwise an internal
     * mutation. Absent for ordinary procedures.
     */
    lifecycle?: LifecycleMoment;

    /**
     * Builder-terminal chain root — the expression to the left of the terminal
     * `.query(...)` (`c.use(...)`) — so callers can walk it further (e.g. to find
     * `.use(rls(...))`). Absent for the bare-factory form.
     */
    receiver?: Node;
    visibility: "internal" | "public";
}

/**
 * Classify an `export const x = …` initializer call as a Lunora registration —
 * its kind and visibility — or `undefined` when it isn't one. Handles both the
 * builder terminal (`c.query(...)`, brand-checked via `__lunoraProcedure` so we
 * don't pick up an unrelated method named `query` on some other object) and the
 * bare factory (`query({…})` / `internalQuery({…})`). The single source of truth
 * for "is this a Lunora procedure, and is it internal?" — shared by function
 * discovery here and the RLS-coverage feeder.
 */
const classifyProcedureCall = (call: CallExpression): ProcedureClassification | undefined => {
    const callee = call.getExpression();

    if (Node.isPropertyAccessExpression(callee)) {
        const method = callee.getName();

        if (!FUNCTION_KINDS.has(method)) {
            return undefined;
        }

        // Callers get the UNWRAPPED receiver: every chain walker built on this
        // (`rlsCallsInChain`, `maskCallsInChain`, `chainHasStep`, …) descends
        // from a call expression, so a `(…)` / `as T` wrapper would stop them at
        // the first hop.
        const wrapped = callee.getExpression();
        const receiver = unwrapExpression(wrapped) ?? wrapped;

        // Fast path: the runtime `__lunoraProcedure` brand. Internal builders
        // also carry `__lunoraVisibility: "internal"`, so its mere presence
        // marks the procedure internal. Works when `@lunora/server` types resolve.
        //
        // Read the brand off the ORIGINAL node first. `as T` and `!` are exactly
        // the operators that narrow, so the brand often lives only on the
        // wrapped type: `(maybeBuilder as Builder)` erases to `Builder |
        // undefined`, whose `getProperty` finds nothing because `undefined` has
        // no members. Checking only the unwrapped node dropped those
        // registrations from `LUNORA_FUNCTIONS` — silently, and only when the
        // chain also failed to root at an imported factory.
        const brandedType = [wrapped, receiver].map((node) => node.getType()).find((type) => type.getProperty("__lunoraProcedure"));

        if (brandedType) {
            return { kind: method, receiver, visibility: brandedType.getProperty("__lunoraVisibility") ? "internal" : "public" };
        }

        // Robust fallback: walk the builder chain (`.input()`/`.use()`/`.output()`)
        // to its root identifier and resolve it by import name — exactly as the
        // bare-factory path does. This keeps discovery working when dependency
        // types aren't installed (e.g. a freshly-scaffolded project before
        // `pnpm install`, where the `__lunoraProcedure` brand can't resolve).
        const rootKind = resolveBuilderRootKind(receiver);

        if (rootKind) {
            return { kind: method, receiver, visibility: rootKind };
        }

        return undefined;
    }

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const exportedName = resolveCalleeKind(callee);

    if (!exportedName) {
        return undefined;
    }

    if (FUNCTION_KINDS.has(exportedName)) {
        return { kind: exportedName, visibility: "public" };
    }

    const internalKind = INTERNAL_FACTORIES[exportedName];

    if (internalKind) {
        return { kind: internalKind, visibility: "internal" };
    }

    const lifecycle = LIFECYCLE_FACTORIES[exportedName];

    if (lifecycle) {
        // A lifecycle hook is an internal mutation tagged with its socket side;
        // it lands in LUNORA_FUNCTIONS for path dispatch and in the lifecycle
        // manifest emit derives from the `lifecycle` tag.
        return { kind: "mutation", lifecycle, visibility: "internal" };
    }

    return undefined;
};

export { classifyProcedureCall };
export type { LifecycleMoment, ProcedureClassification };
