/**
 * The shard mutation id a scheduled function dispatch is deduped on, shared by both receivers
 * (`@lunora/runtime`'s Worker route and `@lunora/platform-node`'s dispatch route) and the
 * producers that compute the scheduling user's scope, so the hosts cannot drift.
 *
 * Every scheduled dispatch reaches the shard in one idempotency namespace (`"system:"`), so a fixed
 * `dedupKey` spent verbatim would let two users, or two functions, answer each other's job from the
 * replay row. The id is therefore a digest of (target function, scheduling user's scope, key).
 *
 * The scope is an unsalted, truncated digest of the user id. It keeps the raw id out of the
 * scheduler's storage, but it is not a secret: anyone who can read a record's scope and knows or
 * guesses a user id can recompute it and confirm the match. Like `shared/dedup-key.ts`, not a
 * package: keep it zero-dependency.
 */

const DEDUP_SCOPE_PATTERN = /^[\da-f]{32}$/u;

const DEDUP_SCOPE_GRAMMAR_MESSAGE = "`dedupScope` must be 32 lowercase hex characters";

const sha256Hex = async (input: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));

    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isDedupScope = (candidate: unknown): candidate is string => typeof candidate === "string" && DEDUP_SCOPE_PATTERN.test(candidate);

/**
 * The scheduling user's dedup scope: the first 32 hex characters of an unsalted SHA-256 over the
 * user id. Not a secret: a reader who knows a user id can recompute it.
 */
const dedupScopeOf = async (userId: string): Promise<string> => (await sha256Hex(userId)).slice(0, 32);

/**
 * The `x-lunora-mutation-id` a scheduled function dispatch carries. NUL separates the parts so no
 * function path, scope or key can be shifted into a neighbour to forge another job's id.
 */
const scheduledMutationId = async (functionPath: string, dedupScope: string | undefined, dedupKey: string): Promise<string> =>
    await sha256Hex(`${functionPath}\u0000${dedupScope ?? ""}\u0000${dedupKey}`);

export { DEDUP_SCOPE_GRAMMAR_MESSAGE, dedupScopeOf, isDedupScope, scheduledMutationId };
