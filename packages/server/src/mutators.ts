/**
 * Custom-mutator authoring API — Zero-style optimistic writes for the
 * local-first sync engine (Phase 4).
 *
 * A mutator pairs one **client** implementation (optimistic, runs in the
 * browser against the local TanStack collections inside a transaction) with one
 * **server** implementation (authoritative, runs inside the shard's Durable
 * Object). The client applies the optimistic write immediately; the DO runs the
 * server impl as the linearization point and the resulting `__cdc_log` rows poke
 * back to every subscriber. The client rebase is free — TanStack DB re-derives
 * pending optimistic overlays over the latest synced base on every sync tick —
 * so this API only has to declare the two impls and their shared `args`.
 *
 * The DO is serialized (`blockConcurrencyWhile` + the storage transaction), so
 * there is **no server-side OCC-retry loop**: a `ConflictError` here is a
 * deterministic self-conflict, not a race to retry.
 *
 * The returned object carries a `__lunoraMutator` brand so `@lunora/codegen`
 * can discover declarations and emit **two** registries: the server impls into
 * the DO bundle, the client impls into the browser bundle (a hard split — a
 * server impl must never reach the browser). Mutators are declared in
 * `lunora/mutators.ts`.
 */

import { LunoraError } from "@lunora/errors";
import type { InferValidatorMap, ValidatorMap } from "@lunora/values";

import contextUserId from "./context-identity";
import { validateArgs } from "./functions";
import type { MutationCtx as MutationContext } from "./types";

/**
 * Enforce a mutator's `owner` scope against the trusted context, then return the
 * args with the owner column set to the **verified** identity.
 *
 * Two guarantees, in order.
 *
 * **Authentication** — no verified identity means nothing is owned, so the write is
 * rejected outright. Mirrors how an `owner`-scoped `defineShape` denies rather than
 * filtering on a nullish value (which a nullable owner column matches).
 *
 * **Attribution** — a client-supplied owner value must equal the verified one (a
 * mismatch is a forgery attempt, not a correctable input), and the field is then
 * overwritten with the verified value regardless. So the impl reads `args[owner]`
 * without trusting the client, and a mutator that declares the column
 * `v.optional(...)` can leave it off the wire entirely.
 */
const applyOwnerScope = <Args extends ValidatorMap>(ownerField: string, context: unknown, parsed: InferValidatorMap<Args>): InferValidatorMap<Args> => {
    if (ownerField.trim() === "") {
        throw new LunoraError("INTERNAL", 'defineMutator: `owner` must name the column carrying the row owner (e.g. `owner: "userId"`)');
    }

    const userId = contextUserId(context);

    if (userId === undefined) {
        throw new LunoraError("UNAUTHORIZED", `defineMutator: an owner-scoped mutator requires a verified identity; none was resolved for this request`);
    }

    // `parsed` is the validated args object this call owns (built by `validateArgs`
    // from the raw payload), so writing the verified owner onto it mutates nothing
    // the caller can observe. The cast is needed because the owner column is named
    // by a runtime string, not statically known to be a key of `Args`.
    const withOwner = parsed as Record<string, unknown>;
    const declared = withOwner[ownerField];

    if (declared !== undefined && declared !== userId) {
        throw new LunoraError(
            "FORBIDDEN",
            `defineMutator: \`${ownerField}\` does not match the verified identity — a mutator may only write rows its caller owns`,
        );
    }

    withOwner[ownerField] = userId;

    return parsed;
};

/**
 * A mutator declaration. `server` is authoritative; `client` is the optimistic
 * twin (optional — omit it to let the optimistic write fall through to the
 * server round-trip with no local preview). Both receive the same validated
 * `args`.
 */
export interface MutatorDefinition<Args extends ValidatorMap = ValidatorMap, ServerContext = MutationContext, ClientTx = unknown, R = unknown> {
    /**
     * Validator for the mutator's arguments. Validated on the DO before `server`
     * runs and (when present) on the client before `client` runs, so both impls
     * see the same parsed shape. Omit for a parameterless mutator.
     */
    readonly args?: Args;

    /**
     * Optimistic client implementation. Runs in a TanStack DB transaction
     * against the local collections; its writes are applied immediately and
     * automatically rolled back / rebased as the authoritative result syncs
     * back. Pure and side-effect-free beyond the local store. Omit to skip the
     * local preview.
     */
    readonly client?: (tx: ClientTx, args: InferValidatorMap<Args>) => Promise<void> | void;

    /**
     * Owner-scope the write: names the column carrying the row owner (e.g.
     * `owner: "userId"`). Before `server` runs, the mutator requires a verified
     * identity, rejects a client-supplied owner that disagrees with it, and sets
     * the column to the verified value — so the impl reads `args[owner]` without
     * trusting the client and never repeats the check by hand.
     *
     * This replaces the "every mutator opens with `assertOwner(ctx, args.userId)`"
     * pattern, and is the write-side counterpart to an `owner`-scoped
     * {@link import("./shapes").ShapeDefinition}. Unlike a shape it takes the column
     * NAME rather than `true`: a shape is bound to one `table`, so the table's
     * `.ownedBy(field)` resolves unambiguously, whereas one mutator may write
     * several tables and has no single owning table to read it from.
     *
     * Declare the column `v.optional(...)` to leave it off the wire entirely; it is
     * injected either way.
     */
    readonly owner?: string;

    /**
     * Authoritative server implementation. Runs inside the shard DO with a full
     * {@link MutationContext} (`ctx.db` writer); its writes append to `__cdc_log`
     * and poke back to subscribers. This is the source of truth — the client
     * impl is only a prediction of it.
     */
    readonly server: (context: ServerContext, args: InferValidatorMap<Args>) => Promise<R> | R;
}

/**
 * A {@link MutatorDefinition} plus the codegen discovery marker and a
 * dispatch-shaped `handler` (validates `args`, then runs `server`) so the DO
 * invokes a mutator exactly like a registered procedure.
 */
export interface RegisteredMutator<
    Args extends ValidatorMap = ValidatorMap,
    ServerContext = MutationContext,
    ClientTx = unknown,
    R = unknown,
> extends MutatorDefinition<Args, ServerContext, ClientTx, R> {
    readonly __lunoraMutator: true;

    /** Validate `rawArgs`, then run the authoritative `server` impl. Used by the DO push path. */
    readonly handler: (context: ServerContext, rawArgs: Record<string, unknown>) => Promise<R>;

    /**
     * Marks the dispatch kind so codegen can register the mutator in the same
     * `LUNORA_FUNCTIONS` table queries/mutations use — the DO's `handleRpc`
     * reads `kind === "mutation"` to wrap the authoritative `server` impl in the
     * shard's BEGIN/COMMIT span (all-or-nothing writes), exactly like an
     * ordinary `mutation`.
     */
    readonly kind: "mutation";
}

/** Declare a custom mutator. See the module docs for runtime semantics. */
export const defineMutator = <Args extends ValidatorMap = ValidatorMap, ServerContext = MutationContext, ClientTx = unknown, R = unknown>(
    definition: MutatorDefinition<Args, ServerContext, ClientTx, R>,
): RegisteredMutator<Args, ServerContext, ClientTx, R> => {
    const handler = async (context: ServerContext, rawArgs: Record<string, unknown>): Promise<R> => {
        const parsed = validateArgs(definition.args ?? ({} as Args), rawArgs);
        const args = definition.owner === undefined ? parsed : applyOwnerScope<Args>(definition.owner, context, parsed);

        return definition.server(context, args);
    };

    return { __lunoraMutator: true, ...definition, handler, kind: "mutation" };
};
