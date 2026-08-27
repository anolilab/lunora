import type { CallExpression, Identifier } from "ts-morph";
import { Node } from "ts-morph";

import { isServerSurfaceModule } from "../../module-specifiers";
import { unwrapExpression } from "../ast";

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
 * Module specifiers a registration factory (`query`/`mutation`/`action`/their
 * `internal*` twins) may legitimately come from — see
 * {@link isServerSurfaceModule} for the three accepted forms and why omitting one
 * silently drops the function from `LUNORA_FUNCTIONS` instead of erroring.
 */
const isLunoraSurfaceModule = isServerSurfaceModule;

/**
 * Resolve a callee identifier through its import declaration, returning the
 * **imported** name (i.e. the name as exported from `@lunora/server` or the
 * generated `_generated/server` re-export). This handles aliasing like
 * `import { query as q }` where the call site uses `q` but the registration kind
 * is `query`. Returns `undefined` when the identifier is not imported from the
 * Lunora surface, so we don't accidentally pick up a local `const query = ...`.
 */
const resolveCalleeKind = (identifier: Identifier): string | undefined => {
    const symbol = identifier.getSymbol();

    // No type-checker info at all (no tsconfig wired up). Fall back to the
    // surface text — preserves the prior behaviour for users that haven't
    // configured ts-morph with a real project.
    if (!symbol) {
        return identifier.getText();
    }

    const declarations = symbol.getDeclarations();

    for (const declaration of declarations) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getImportDeclaration();
        const moduleSpecifier = importDeclaration.getModuleSpecifierValue();

        // Only trust identifiers imported from the Lunora surface (the public
        // package or the generated `_generated/server` re-export).
        if (!isLunoraSurfaceModule(moduleSpecifier)) {
            return undefined;
        }

        // `import { query as q }` → declaration.getNameNode() is `query`,
        // declaration.getAliasNode() is `q`. The kind we care about is the
        // exported name, not the local alias.
        return declaration.getNameNode().getText();
    }

    // Symbol exists but no `@lunora/server` import specifier among its
    // declarations — it's a local binding (`const query = ...`) or imported
    // from somewhere else. Reject so we don't pick it up as a registration.
    return undefined;
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
    let current: Node | undefined = unwrapExpression(receiver);

    // Each builder step (`x.input({...})`, `x.use(...)`, `x.output(...)`) is a
    // CallExpression whose callee is a PropertyAccess; descend to its receiver.
    while (current && Node.isCallExpression(current)) {
        const inner = unwrapExpression(current.getExpression());

        if (!inner || !Node.isPropertyAccessExpression(inner)) {
            return undefined;
        }

        current = unwrapExpression(inner.getExpression());
    }

    return current && Node.isIdentifier(current) ? current : undefined;
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

        // Hand callers the UNWRAPPED receiver. Every chain walker built on this
        // (`rlsCallsInChain`, `maskCallsInChain`, `chainHasStep`, …) descends
        // from a call expression, so a `(…)` / `as T` wrapper would stop them at
        // the first hop. Unwrapping also makes the brand check below read the
        // builder's real type rather than whatever a cast asserted.
        const receiver = unwrapExpression(callee.getExpression()) ?? callee.getExpression();

        // Fast path: the runtime `__lunoraProcedure` brand on the receiver's
        // type. Internal builders also carry `__lunoraVisibility: "internal"`,
        // so its mere presence marks the procedure internal. This works when the
        // project's `@lunora/server` types resolve.
        if (receiver.getType().getProperty("__lunoraProcedure")) {
            return { kind: method, receiver, visibility: receiver.getType().getProperty("__lunoraVisibility") ? "internal" : "public" };
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

    const calleeName = resolveCalleeKind(callee);

    if (!calleeName) {
        return undefined;
    }

    if (FUNCTION_KINDS.has(calleeName)) {
        return { kind: calleeName, visibility: "public" };
    }

    const internalKind = INTERNAL_FACTORIES[calleeName];

    if (internalKind) {
        return { kind: internalKind, visibility: "internal" };
    }

    const lifecycle = LIFECYCLE_FACTORIES[calleeName];

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
