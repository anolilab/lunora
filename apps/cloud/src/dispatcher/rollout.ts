/**
 * Staged rollouts — serve a new release to a percentage of traffic before it
 * takes over (GAPS.md A1 follow-on).
 *
 * Blue/green already exists: a release is promoted by swapping the project's
 * active pointer, and rolled back by swapping it back. That is all-or-nothing.
 * A rollout keeps both scripts live at once and splits traffic between them, so
 * a regression is discovered by a fraction of users instead of all of them — and
 * the metering stream already records outcome per script, so the comparison that
 * decides whether to continue is a read, not new instrumentation.
 *
 * **The split is deterministic and monotonic.** A request's bucket comes from
 * hashing a stable key, and a bucket serves the candidate when it falls below
 * the current percentage. Two properties follow, and both matter:
 *
 * - *Deterministic*: the same client keeps getting the same version instead of
 *   flipping between two builds mid-session, which for a stateful backend is the
 *   difference between a canary and a bug report.
 * - *Monotonic*: raising 10% to 25% only ever ADDS buckets. Nobody who was
 *   already on the candidate is moved back, so advancing a rollout cannot itself
 *   look like a regression.
 *
 * Random assignment would have neither, and a cookie would have both only for
 * browsers — a Lunora app's callers are frequently other programs.
 */

/** Buckets a rollout splits traffic into. 100 so the percentage IS the bucket count. */
const ROLLOUT_BUCKETS = 100;

/** FNV-1a offset basis / prime — a small, fast, sync hash with good spread over short keys. */
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;

/**
 * Map a stable key to a bucket in `[0, 100)`.
 *
 * FNV-1a rather than a crypto digest: this runs on every request to a project
 * mid-rollout, and `crypto.subtle` is async — awaiting a hash to pick a backend
 * would add a microtask to the hot path to answer a question with no security
 * property. Bucketing is a load-splitting decision, not an authorization one.
 */
export const rolloutBucket = (key: string): number => {
    let hash = FNV_OFFSET;

    for (let index = 0; index < key.length; index += 1) {
        // eslint-disable-next-line no-bitwise, unicorn/prefer-code-point -- FNV-1a is defined over 32-bit XOR/multiply of code UNITS
        hash ^= key.charCodeAt(index);
        // `Math.imul` keeps the multiply in 32-bit space; a plain `*` would lose
        // precision past 2^53 and collapse the spread.
        hash = Math.imul(hash, FNV_PRIME);
    }

    // eslint-disable-next-line no-bitwise -- coerce the signed 32-bit result to unsigned
    return (hash >>> 0) % ROLLOUT_BUCKETS;
};

/**
 * Should this key be served the candidate release?
 *
 * `< percent` is what makes the split monotonic: at 10 the candidate serves
 * buckets 0–9, at 25 it serves 0–24, and everyone already on it stays on it.
 */
export const servesCandidate = (key: string, percent: number): boolean => {
    if (!Number.isFinite(percent) || percent <= 0) {
        return false;
    }

    if (percent >= ROLLOUT_BUCKETS) {
        return true;
    }

    return rolloutBucket(key) < Math.floor(percent);
};

/**
 * The key a request is bucketed by.
 *
 * The client IP, scoped by the alias so the same client lands in different
 * buckets for different projects — otherwise one unlucky address would sit in
 * the candidate group for every rollout across the platform at once, and a
 * caller who saw one bad canary would see all of them.
 *
 * A missing IP is bucketed under a fixed sentinel rather than randomly: an
 * unidentifiable caller should get a stable answer, and putting them all in the
 * same bucket means they move together at a predictable threshold instead of
 * spraying across the split.
 *
 * **Known ceiling:** clients behind one NAT share a bucket, so a small rollout
 * reaches fewer distinct users than the percentage suggests. Acceptable for a
 * canary — the alternative is a cookie, which a non-browser caller does not have.
 */
export const rolloutKey = (clientIp: null | string, alias: string): string => `${clientIp ?? "unknown"}:${alias}`;

export { ROLLOUT_BUCKETS };
