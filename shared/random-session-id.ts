/**
 * Canonical presence session-id generator shared across the framework adapters
 * (`@lunora/react`, `@lunora/vue`, `@lunora/svelte`, `@lunora/solid`,
 * `@lunora/angular`). A presence session id is a non-secret correlation handle,
 * but it must still be minted from Web Crypto (never `Math.random`) so it can't
 * be treated as an insecure-randomness source flowing into a security context.
 *
 * There must be exactly ONE definition rather than byte-similar copies that can
 * drift: an earlier `@lunora/angular` copy was a bare `crypto.randomUUID()` with
 * no fallback (diverging from the hardened sibling adapters and throwing on any
 * runtime that lacks `randomUUID`), which is the precise drift this file exists
 * to prevent — mirroring `shared/constant-time-equal.ts`.
 *
 * Resolution order — every path returns a bare, unprefixed id:
 *   1. `crypto.randomUUID()` — every modern browser, workerd, and Node 22+.
 *   2. `crypto.getRandomValues()` — a non-secure origin (a plain-HTTP LAN
 *      dev/preview server) leaves `crypto.randomUUID` UNDEFINED while still
 *      shipping Web Crypto's CSPRNG; hex-encode 16 bytes.
 *
 * There is deliberately no third arm. It used to fall back to
 * `Date.now().toString(36)`, which is not an id: two presence sessions opened in
 * the same millisecond get the SAME string and collapse onto one presence row,
 * and the value is trivially guessable by anyone who knows roughly when a peer
 * joined. Every target this runs on (browsers, workerd, Node 22+) ships
 * `crypto.getRandomValues` — it predates `randomUUID` by a decade and, unlike
 * it, is available on insecure origins — so arm 2 always answers and the throw
 * below is unreachable in practice. Failing loudly on a runtime with no Web
 * Crypto at all beats minting colliding session ids there.
 *
 * The whole `crypto` reference is guarded (not just `randomUUID`): some SSR /
 * older runtimes leave `crypto` undefined, where reading `.randomUUID` off it
 * throws a TypeError instead of falling through. `typeof crypto` (rather than
 * `globalThis.crypto !== undefined`) is the form the lib's non-nullable `Crypto`
 * typing leaves intact.
 *
 * Like `shared/constant-time-equal.ts`, this is deliberately **not** a package:
 * consumers import it by relative path and the bundler (packem/rollup) inlines
 * it — no runtime dependency edge. Keep it genuinely zero-dependency
 * (relative/built-in imports only) or inlining breaks. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */
const randomSessionId = (): string => {
    if (typeof crypto !== "undefined") {
        if (typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }

        if (typeof crypto.getRandomValues === "function") {
            const bytes = crypto.getRandomValues(new Uint8Array(16));

            return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        }
    }

    throw new Error("randomSessionId: no Web Crypto available — a session id needs crypto.randomUUID or crypto.getRandomValues");
};

export { randomSessionId };
