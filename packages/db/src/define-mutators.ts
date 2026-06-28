/* eslint-disable import/exports-last -- a types-heavy module: public types are declared next to the helpers they build on */
import type { LunoraClient } from "@lunora/client";
import type { Collection, Transaction } from "@tanstack/db";
import { createTransaction } from "@tanstack/db";

import type { CheckpointRegistry } from "./collection-options";
import type { Row } from "./internals";
import { runOutboxMutation } from "./internals";

/** The local store a client mutator's optimistic body writes against. */
export interface ClientMutatorContext {
    /** The wired collections, keyed by name — apply optimistic inserts/updates/deletes here. */
    collections: Record<string, Collection<Row, string>>;
}

/** A client-side custom mutator: an optimistic body plus the path of its authoritative server impl. */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Def" mirrors `CollectionDef`; "Definition" is noise
export interface ClientMutatorDef<TArgs> {
    /** Brand so codegen / `bindMutators` can recognize a mutator definition. */
    __lunoraClientMutator: true;
    /** The optimistic update applied to the local collections before the server confirms. */
    apply: (context: ClientMutatorContext, args: TArgs) => void;
    /** The Lunora function path of the server-authoritative mutator (`defineMutator` on the server). */
    serverRef: string;
}

/**
 * Declare a client-side custom mutator. `apply` runs optimistically against the
 * local TanStack collections; `serverRef` names the authoritative server mutator
 * the write is pushed to over the watermark protocol. The server impl is the
 * linearization point — this body is a prediction the server can override.
 */
export const defineMutator = <TArgs = Record<string, unknown>>(definition: {
    apply: (context: ClientMutatorContext, args: TArgs) => void;
    serverRef: string;
}): ClientMutatorDef<TArgs> => {
    return {
        __lunoraClientMutator: true,
        apply: definition.apply,
        serverRef: definition.serverRef,
    };
};

// A mutator map with arg types erased to `any` — pinning the constraint to
// `ClientMutatorDef<unknown>` rejects concrete defs (the `apply` arg is
// contravariant), exactly as `AnyDef` does in `define-collections`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
type AnyMutatorMap = Record<string, ClientMutatorDef<any>>;

/** Args type of a mutator definition. */
type ArgsOf<M> = M extends ClientMutatorDef<infer A> ? A : never;

/** Inputs `bindMutators` needs to run a mutator: the local store + how the overlay drops. */
export interface BindMutatorsContext {
    /**
     * Resolves the optimistic-overlay drop against confirmed server watermarks.
     * When supplied, a mutation's overlay is held until the sync stream echoes
     * `lastMutationId >= clientSeq` (via {@link CheckpointRegistry.resolve}) — no
     * flicker. When omitted, the overlay drops as soon as the server accepts the
     * write (the by-value sync diff then converges the synced row in place).
     */
    checkpoints?: CheckpointRegistry;
    /** The wired collections the optimistic bodies write against. */
    collections: Record<string, Collection<Row, string>>;
    /** Optional shard key the mutator's server push is routed to. */
    shardKey?: string;
}

/** Calling a bound mutator runs the optimistic body + pushes the server write; returns the TanStack transaction. */
export type BoundMutators<M extends AnyMutatorMap> = {
    [K in keyof M]: (args: ArgsOf<M[K]>) => Transaction;
};

/**
 * Bind a set of client mutators to a client + local store. Each returned handle,
 * when called, opens a TanStack optimistic transaction: the mutator's `apply`
 * body writes the predicted rows into the collections, and the transaction's
 * `mutationFn` pushes the authoritative write through
 * {@link LunoraClient.callMutator} under a monotonic per-client `clientSeq`.
 *
 * Rebase-on-poke is free — TanStack DB re-derives every pending optimistic overlay
 * over the latest synced base on each sync tick. The overlay is dropped when the
 * server confirms the write (and, if `checkpoints` is supplied, once it echoes the
 * matching watermark so the synced row has landed).
 *
 * The `clientSeq` generator is seeded from the server's echoed watermark
 * ({@link LunoraClient.confirmedMutationWatermark}) on every issue, so a reload —
 * which resets this in-memory counter while the server keeps a durable per-client
 * watermark — never reissues a sequence the DO has already applied. As a backstop
 * for the very first push of a fresh session (before any ack has taught the client
 * the watermark), a push the DO swallows as a replay (`applied === false`) is
 * reissued above the now-known watermark instead of being mistaken for a confirmed
 * write — closing the silent-drop window without risking a double-apply (a fresh
 * session's first stale push provably cannot be an honest replay).
 *
 * Pushes are **serialized per binding** (a FIFO chain): the DO rejects any push
 * with `clientSeq > watermark + 1` as `OUT_OF_ORDER` and drops the write, so two
 * mutators fired concurrently must not race the network into a gap. Each push
 * waits for the previous one's ack and assigns its `clientSeq` *inside* the
 * critical section — from the live watermark — so the sequence is always exactly
 * `watermark + 1`. Because a failed mutation never advances the server watermark,
 * a permanently-rejected predecessor can't wedge the chain: the next push simply
 * reclaims the same `watermark + 1` instead of leaving a hole the DO waits on.
 */
export const bindMutators = <M extends AnyMutatorMap>(client: LunoraClient, context: BindMutatorsContext, mutators: M): BoundMutators<M> => {
    // Backstop bound on the reissue loop: the watermark is finite and each retry
    // strictly raises the sequence toward it, so this only trips on a pathological
    // server (or a same-clientId tab racing the watermark forever) — surfaced as a
    // hard error rather than an infinite loop.
    const maxReissues = 32;
    let counter = 0;

    // Seed `counter` from the highest watermark the server has confirmed for this
    // shard, then claim the next sequence — keeping issuance monotonic across reloads.
    const nextClientSeq = (): number => {
        counter = Math.max(counter, client.confirmedMutationWatermark(context.shardKey)) + 1;

        return counter;
    };

    // Per-binding FIFO push chain: every server push for this shard runs behind
    // the previous one so the DO receives them in strict watermark order (an
    // out-of-order arrival would be rejected as `OUT_OF_ORDER` and lost).
    let pushChain: Promise<unknown> = Promise.resolve();

    // Serialize one push behind the chain, assigning + reissuing the sequence
    // inside the critical section so it tracks the live watermark. Resolves with
    // the applied `clientSeq` so the caller can await the matching checkpoint.
    const pushSerialized = (serverRef: string, args: Record<string, unknown>): Promise<number> => {
        const run = pushChain.then(async () => {
            for (let attempt = 0; ; attempt += 1) {
                const clientSeq = nextClientSeq();
                // eslint-disable-next-line no-await-in-loop -- sequential by design: each reissue must observe the prior ack's watermark before claiming a fresh sequence
                const { applied } = await client.callMutator(serverRef, args, {
                    clientSeq,
                    shardKey: context.shardKey,
                });

                if (applied) {
                    return clientSeq;
                }

                if (attempt >= maxReissues) {
                    throw new Error(`lunora: custom mutator "${serverRef}" could not claim a fresh client sequence after ${String(maxReissues)} attempts`);
                }

                // The DO swallowed this push as a replay (a stale `clientSeq` after
                // a reload). Reissue above the watermark it just echoed.
            }
        });

        // Keep the chain alive even when this push throws, so a failed (or
        // permanently-rejected) push never wedges the queue for later mutators.
        pushChain = run.then(
            () => undefined,
            () => undefined,
        );

        return run;
    };

    const bound: Record<string, (args: unknown) => Transaction> = {};

    for (const [name, mutator] of Object.entries(mutators)) {
        bound[name] = (args) => {
            const transaction = createTransaction({
                autoCommit: true,
                metadata: { serverRef: mutator.serverRef },
                mutationFn: async () => {
                    let appliedSeq = 0;

                    await runOutboxMutation(async () => {
                        appliedSeq = await pushSerialized(mutator.serverRef, args as Record<string, unknown>);
                    });

                    // Hold the overlay until the synced row lands (the poke echoes
                    // this client's `lastMutationId`). Skipped when no watermark
                    // stream is wired — the by-value diff converges in place.
                    if (context.checkpoints) {
                        await context.checkpoints.awaitMutationId(appliedSeq);
                    }
                },
            });

            transaction.mutate(() => {
                mutator.apply({ collections: context.collections }, args);
            });

            return transaction;
        };
    }

    return bound as BoundMutators<M>;
};
