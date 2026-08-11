/**
 * The deterministic scope a mutation body runs inside.
 *
 * A mutation is not an ordinary function: it may be re-executed (an OCC retry, a
 * replayed dispatch), its result is cached by idempotency key, and its writes
 * feed a changelog that subscriptions re-derive from. Ambient nondeterminism
 * breaks all three in ways that only show up in production — `Date.now()` read
 * twice in one handler yields two different "now"s, `Math.random()` makes a
 * replay write different rows, and a `fetch` in the write path makes an atomic
 * transaction depend on someone else's uptime.
 *
 * The advisor flags these statically (`nondeterministic_query_mutation`), but a
 * lint only catches the call sites it can see — not the ones inside a dependency.
 * So the runtime closes it too, by replacing the ambient sources for the duration
 * of the mutation rather than merely forbidding them:
 *
 * `Date.now()` returns the instant the mutation began, so a handler reading the
 * clock twice sees one value. `Math.random()` becomes a seeded PRNG, so the
 * sequence is a function of the seed instead of the host's entropy. `fetch`
 * throws — network I/O belongs in an action, because a transaction that awaits a
 * third party cannot be atomic.
 *
 * **Scope of the guarantee.** Values are stable WITHIN one execution — the point
 * is that a handler reading the clock twice sees one instant. They are not
 * identical across two separate executions of the same mutation (a retry gets a
 * fresh `now`, hence a fresh seed), which matches what the platform can honestly
 * promise: an idempotency key, not a replayed clock, is what makes a retry safe.
 *
 * **Why only mutations.** Patching a global is only sound while nothing else can
 * observe it. A mutation holds the DO's single-writer gate, so nothing else runs
 * during it. Queries interleave (a deferred subscription re-run lands between two
 * awaits of another query), so freezing the clock for one would hand its instant
 * to the other — a worse lie than the one being fixed. Queries keep the static
 * lint and the `ctx.now`/`ctx.fetch` surfaces instead.
 */
import { LunoraError } from "@lunora/errors";

/** Mixing increment of the published mulberry32 PRNG. */
const MULBERRY_INCREMENT = 0x6d_2b_79_f5;

/** 2^32 — divisor that maps the PRNG's 32-bit output into `[0, 1)`. */
const UINT32_RANGE = 4_294_967_296;

/* eslint-disable no-bitwise -- FNV-1a and mulberry32 ARE bit manipulation; both
   are fixed published algorithms whose constants and shifts define the
   distribution, so expressing them otherwise would only obscure them. Mirrors
   the same disable in `shard-ring.ts`. */

/** FNV-1a (32-bit) over a string, so a seed derives deterministically from the dispatch identity. */
const seedFrom = (text: string): number => {
    let hash = 0x81_1c_9d_c5;

    for (const character of text) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01_00_01_93);
    }

    return hash >>> 0;
};

/** A small, well-distributed 32-bit PRNG (mulberry32) — enough for a seeded `Math.random`. */
const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;

    return () => {
        state = (state + MULBERRY_INCREMENT) >>> 0;

        let next = state;

        next = Math.imul(next ^ (next >>> 15), next | 1);
        next ^= next + Math.imul(next ^ (next >>> 7), next | 61);

        return ((next ^ (next >>> 14)) >>> 0) / UINT32_RANGE;
    };
};

/* eslint-enable no-bitwise */

/** The ambient sources this scope replaces, captured so they can be restored exactly. */
interface AmbientSources {
    fetch: typeof globalThis.fetch;
    now: () => number;
    random: () => number;
}

/**
 * Run `body` with `Date.now`, `Math.random`, and `fetch` replaced by their
 * deterministic counterparts, restoring the originals afterwards — including when
 * `body` throws.
 *
 * `now` is the dispatch instant (the same one `ctx.now` exposes) and `seed` should
 * identify the dispatch (function path + instant + any idempotency key), so two
 * different mutations never share a random sequence.
 */
const withDeterministicScope = async <T>(options: { now: number; seed: string }, body: () => Promise<T> | T): Promise<T> => {
    const original: AmbientSources = { fetch: globalThis.fetch, now: Date.now, random: Math.random };
    const random = mulberry32(seedFrom(options.seed));

    Date.now = () => options.now;
    Math.random = random;
    globalThis.fetch = () => {
        throw new LunoraError(
            "NETWORK_IN_MUTATION",
            "fetch is not available inside a mutation: a transaction that awaits a third party cannot be atomic. Move the call to an action (or schedule one).",
            { status: 500 },
        );
    };

    try {
        return await body();
    } finally {
        Date.now = original.now;
        Math.random = original.random;
        globalThis.fetch = original.fetch;
    }
};

export { mulberry32, seedFrom, withDeterministicScope };
