/**
 * Canonical process-unique id generator, shared so byte-similar copies can't
 * drift. Consolidates `@lunora/client`'s offline-queue `nextId` (mutation /
 * fallback-`clientId` identity) and `@lunora/replica`'s `createTableDiff`
 * diff identity.
 *
 * Resolution order:
 *   1. `crypto.randomUUID()` — every modern browser (secure context), workerd,
 *      and Node 22+.
 *   2. `crypto.getRandomValues()` — non-secure origins (e.g. a plain-HTTP
 *      `http://192.168.x.x` LAN dev/preview server) leave `crypto.randomUUID`
 *      UNDEFINED, so a bare call throws a TypeError; those runtimes still ship
 *      Web Crypto's CSPRNG, so hex-encode 8 bytes behind a timestamp + counter.
 *   3. `Math.random()` — no Web Crypto at all (very old/exotic runtime). This is
 *      a non-secret local-uniqueness handle, not a token, so a non-CSPRNG source
 *      is acceptable here as the last resort.
 *
 * The whole `crypto` reference is guarded (not just `.randomUUID`): some SSR /
 * older runtimes leave `crypto` undefined, where reading a property off it
 * throws instead of falling through. `typeof crypto` (rather than
 * `globalThis.crypto !== undefined`) is the form the lib's non-nullable `Crypto`
 * typing leaves intact.
 *
 * The `Date.now()` + monotonic counter mix in the fallback guarantees two ids
 * minted in the SAME millisecond still differ — required by
 * `@lunora/replica`'s `deriveInsertId`, which mints deterministic row ids per
 * diff, and by the anonymous-`clientId` uniqueness `@lunora/client` relies on.
 *
 * Like the sibling `shared/*` helpers, this is deliberately **not** a package:
 * consumers import it by relative path and the bundler (packem/rollup) inlines
 * it — no runtime dependency edge. Keep it genuinely zero-dependency
 * (relative/built-in imports only) or inlining breaks. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */
let idCounter = 0;

const randomId = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    idCounter += 1;

    const entropy =
        typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
            ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("")
            : // eslint-disable-next-line sonarjs/pseudo-random -- non-cryptographic local-uniqueness entropy, not a security token; only reached when neither crypto.randomUUID nor crypto.getRandomValues exists
              Math.random().toString(16).slice(2, 12);

    return `m_${Date.now().toString(36)}_${idCounter.toString(36)}_${entropy}`;
};

export { randomId };
