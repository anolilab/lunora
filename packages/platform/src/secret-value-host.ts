/**
 * `SecretValueHost` — the provider-neutral contract for holding one secret
 * value between the moment a human supplies it and the moment a durable step
 * consumes it, without the value ever travelling in a workflow event, a step
 * result, a message row or a model context.
 *
 * Only the opaque ref returned by {@link SecretValueHost.put} travels; the
 * value is read back once, by the claimant that first took it, through
 * {@link SecretValueHost.take}.
 *
 * This is deliberately NOT a `ShardKvStore`. `ShardKvStore.list` must
 * enumerate every key under a prefix, which would make secrets listable, and a
 * KV store has no atomic read-and-bind. The contract has exactly three members
 * and no `get`, `list` or `has`: there is no way to ask "what is stored under
 * this ref" except by presenting the scope and claimant that own it.
 *
 * Guarantees a host must provide:
 * 1. **Unguessable refs** — `put` mints the ref; two puts never return the same
 * ref, and a ref cannot be derived from another ref or from the value.
 * 2. **Scope** — `take` with a scope other than the one `put` recorded returns
 * `undefined` and does not consume the value.
 * 3. **One claimant** — the first successful `take` binds the ref to its
 * `claimant`. The same claimant may take again (a retried durable step must
 * not find its own ref spent); any other claimant gets `undefined`.
 * 4. **Expiry refuses reads** — once `ttlMs` has elapsed, `take` returns
 * `undefined` whether or not the value has been physically removed yet.
 * Physical removal is best-effort and bounded; it is not a correctness
 * mechanism.
 *
 * "One use means one claimant", not "one read": the value stays readable by its
 * claimant until it expires or is discarded. The TTL is the backstop for a
 * crash between a successful `take` and `discard`.
 *
 * Internal contract. Only host adapters and the agent layer consume it.
 */

/** Largest value `put` accepts, in UTF-8 bytes. */
export const SECRET_VALUE_MAX_BYTES: number = 8192;

/** Longest lifetime `put` grants, regardless of the requested `ttlMs`. */
export const SECRET_VALUE_MAX_TTL_MS: number = 24 * 60 * 60 * 1000;

/** Thrown by {@link SecretValueHost.put} when the value exceeds {@link SECRET_VALUE_MAX_BYTES}. */
export class SecretValueTooLargeError extends Error {
    public readonly code = "SECRET_VALUE_TOO_LARGE";

    public constructor(bytes: number) {
        super(`secret value is ${String(bytes)} bytes; the limit is ${String(SECRET_VALUE_MAX_BYTES)}`);
        this.name = "SecretValueTooLargeError";
    }
}

/**
 * Clamp a requested lifetime to `[1, SECRET_VALUE_MAX_TTL_MS]`, shared by every
 * host so the bound is stated once. A non-finite request is a caller bug, not a
 * value to clamp.
 * @throws {RangeError} when `ttlMs` is `NaN` or infinite
 */
export const clampSecretValueTtl = (ttlMs: number): number => {
    if (!Number.isFinite(ttlMs)) {
        throw new RangeError(`secret value ttlMs must be finite, got ${String(ttlMs)}`);
    }

    return Math.min(SECRET_VALUE_MAX_TTL_MS, Math.max(1, Math.floor(ttlMs)));
};

/**
 * Reject a value over {@link SECRET_VALUE_MAX_BYTES}, counted in UTF-8 bytes
 * (a character count would let a multi-byte value exceed the limit).
 * @throws {SecretValueTooLargeError} when the value is too large
 */
export const assertSecretValueSize = (value: string): void => {
    const bytes = new TextEncoder().encode(value).byteLength;

    if (bytes > SECRET_VALUE_MAX_BYTES) {
        throw new SecretValueTooLargeError(bytes);
    }
};

/** Options for {@link SecretValueHost.put}. */
export interface SecretValuePutOptions {
    /** The scope `take` must present to read the value back (e.g. an agent run id). */
    scope: string;

    /**
     * Lifetime in milliseconds. Mandatory, so no value is stored without an
     * expiry; the host clamps it to `[1, SECRET_VALUE_MAX_TTL_MS]`.
     */
    ttlMs: number;
}

/** Options for {@link SecretValueHost.take}. */
export interface SecretValueTakeOptions {
    /** Identity binding the ref on first take. Any other claimant is refused thereafter. */
    claimant: string;
    /** Must equal the scope the value was put under. */
    scope: string;
}

/**
 * The secret-value contract for one shard. One instance per shard.
 */
export interface SecretValueHost {
    /**
     * Discard the value under `ref`. Resolves `true` when a value was removed,
     * `false` when none was present (already discarded, expired-and-swept, or
     * never issued). Idempotent.
     */
    discard: (ref: string) => Promise<boolean>;

    /**
     * Store `value` and return the host-minted ref that names it.
     * @throws {@link SecretValueTooLargeError} when `value` exceeds {@link SECRET_VALUE_MAX_BYTES} UTF-8 bytes.
     */
    put: (value: string, options: SecretValuePutOptions) => Promise<string>;

    /**
     * Read the value under `ref` on behalf of `claimant`.
     * @returns the value, or `undefined` when the ref is unknown, expired,
     * presented under the wrong scope, or already bound to a different claimant.
     * The first successful take binds the ref to `claimant`.
     */
    take: (ref: string, options: SecretValueTakeOptions) => Promise<string | undefined>;
}

/**
 * The raw layer beneath an encrypting {@link SecretValueHost}. It mints the ref
 * and the expiry itself, awaits `seal(ref)` for the bytes to store under that
 * ref, then writes. The ref therefore exists before the bytes do, which is what
 * lets the ciphertext bind the ref into its authenticated data. `seal` is not
 * optional: a store has no way to write a value of its own.
 *
 * Deliberately not a {@link SecretValueHost}: its `put` takes a function where
 * the host takes a value, so a plaintext path cannot be wired to it by accident.
 * `take` returns exactly the bytes `seal` produced.
 */
export interface SecretValueStore {
    /** Remove the record under `ref`. Resolves `true` when one was removed. */
    discard: (ref: string) => Promise<boolean>;

    /** Mint a ref, store `await seal(ref)` under it, and return the ref. */
    put: (seal: (ref: string) => Promise<string>, options: SecretValuePutOptions) => Promise<string>;

    /** Apply the claimant, scope and expiry rules of {@link SecretValueHost.take} and return the stored bytes. */
    take: (ref: string, options: SecretValueTakeOptions) => Promise<string | undefined>;
}
