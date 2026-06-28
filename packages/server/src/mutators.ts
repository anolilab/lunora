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

import type { InferValidatorMap, ValidatorMap } from "@lunora/values";

import { validateArgs } from "./functions";
import type { MutationCtx as MutationContext } from "./types";

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

        return definition.server(context, parsed);
    };

    return { __lunoraMutator: true, ...definition, handler, kind: "mutation" };
};
