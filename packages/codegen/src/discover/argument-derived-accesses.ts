import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext, isUnmodifiedArgumentPassthrough } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";

/**
 * The sink method name when `node` is a `<receiver>.<method>` property access
 * satisfying `config` (name in `config.methods`, receiver text accepted by
 * `config.matchReceiver`), else `undefined`. Matched by shape — the same
 * `import`-agnostic, fail-closed convention every argument-derived-access
 * feeder uses. Receiver aliases (`const kv = ctx.kv; kv.get(...)`) are
 * deliberately not resolved — matching is on the literal receiver text.
 */
const sinkMethod = (node: TsNode, config: ArgumentDerivedAccessConfig): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!config.methods.has(method)) {
        return undefined;
    }

    return config.matchReceiver(node.getExpression().getText()) ? method : undefined;
};

/** The IR row for a sink call whose `config.argIndex` argument is arg-derived and unscoped, or `undefined`. */
const accessInCall = (call: CallExpression, relativePath: string, config: ArgumentDerivedAccessConfig): ArgumentDerivedAccessIR | undefined => {
    const method = sinkMethod(call.getExpression(), config);

    if (method === undefined) {
        return undefined;
    }

    const key = call.getArguments()[config.argIndex];

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a value like `` `${ctx.auth.userId}:${args.id}` ``
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (!key || !isArgumentDerived(key) || isScopedByContext(key)) {
        return undefined;
    }

    // Some sinks (storage keys) only care about caller-controlled input reaching
    // the sink UNMODIFIED — a value rebuilt by an intervening call (a
    // content-addressed hash, an encoder) is no longer the bytes the caller chose,
    // even though it textually references `args`.
    // eslint-disable-next-line no-secrets/no-secrets -- the referenced helper name below, not a credential
    // See `isUnmodifiedArgumentPassthrough`.
    if (config.requireUnmodifiedReach === true && !isUnmodifiedArgumentPassthrough(key)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/** Arg-derived, unscoped sink accesses matching `config` in one source file. */
const accessesInSourceFile = (sourceFile: SourceFile, relativePath: string, config: ArgumentDerivedAccessConfig): ArgumentDerivedAccessIR[] => {
    const found: ArgumentDerivedAccessIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const access = accessInCall(call, relativePath, config);

        if (access) {
            found.push(access);
        }
    }

    return found;
};

/**
 * One IR row shared by every argument-derived property-access sink feeder built
 * on {@link discoverArgumentDerivedAccesses}: the exported procedure performing
 * the call, its source location, and the sink method invoked. Structurally
 * identical to `KvKeyAccessIR` / `ContainerKeyAccessIR` / `StorageKeyAccessIR` /
 * `BrowserUrlAccessIR` in `./ir` — those per-binding names are kept (for
 * call-site readability and stable public IR naming) but are assignable to/from
 * this shape.
 */
export interface ArgumentDerivedAccessIR {
    /** Export binding name of the procedure performing the sink call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the sink call, or `0` when unknown. */
    line: number;
    /** The sink method invoked (one of `config.methods`). */
    method: string;
}

/**
 * Per-binding configuration for {@link discoverArgumentDerivedAccesses}: which
 * `<receiver>.<method>(...)` property-access calls count as this binding's
 * sink, and which call argument carries the potentially-tainted value.
 */
export interface ArgumentDerivedAccessConfig {
    /** 0-based index of the call argument checked for arg-derived, unscoped taint. */
    argIndex: number;
    /** `true` when `receiverText` — the property access's receiver, as source text — is this binding's sink receiver. */
    matchReceiver: (receiverText: string) => boolean;
    /** The sink methods this binding cares about (the property-access name). */
    methods: ReadonlySet<string>;

    /**
     * When `true`, also require the sink argument to reach the sink UNMODIFIED —
     * see {@link isUnmodifiedArgumentPassthrough}. A value rebuilt by an
     * intervening call (e.g. a content-addressed hash minted server-side) still
     * textually references `args` but is no longer caller-controlled input, so it
     * is not recorded. Off by default — most sinks want the broader, fail-open
     * "embeds `args.*` anywhere" match `isArgumentDerived` already gives.
     */
    requireUnmodifiedReach?: boolean;
}

/**
 * Shared AST walk behind the argument-derived property-access sink feeders
 * (`ctx.kv`, `ctx.containers.*.get`, `ctx.storage.*`, `ctx.browser`): one IR row
 * per call in `lunora/` whose callee is a `<receiver>.<method>` property access
 * matching `config` and whose `config.argIndex` argument is derived from the
 * handler's `args` (directly, or through one local `const` hop) with no
 * server-side scoping. A fixed literal, or a value scoped by a server-trusted
 * `ctx.*` reference, is not recorded.
 *
 * Sinks whose tainted value is nested inside an object-literal argument
 * (Vectorize's `input.namespace`, the image-delivery-URL builder's `key`) or
 * whose callee is not a property access don't fit this shape and keep their own
 * hand-written feeder.
 */
export const discoverArgumentDerivedAccesses = (project: Project, lunoraDirectory: string, config: ArgumentDerivedAccessConfig): ArgumentDerivedAccessIR[] => {
    const accesses: ArgumentDerivedAccessIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        accesses.push(...accessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath), config));
    }

    return accesses;
};
