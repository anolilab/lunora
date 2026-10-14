/**
 * Read the verified user id off a **trusted** server context — the one the shard
 * DO built from the socket's authenticated identity, never anything a client
 * supplied. Shared by the owner-scoping paths of `defineShape` and
 * `defineMutator` so reads and writes resolve "who is this" identically.
 *
 * The context is typed `unknown` at these dispatch boundaries (the DO hands the
 * concrete ctx back through an erased seam), so the read is structural.
 *
 * Returns `undefined` for an anonymous caller — callers must treat that as "owns
 * nothing" and fail closed, never as a value to compare or filter on.
 */
const contextUserId = (context: unknown): string | undefined => {
    const userId = (context as { auth?: { userId?: null | string } } | null)?.auth?.userId;

    return userId ?? undefined;
};

export default contextUserId;
