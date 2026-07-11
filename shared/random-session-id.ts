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
 * Resolution order:
 *   1. `crypto.randomUUID()` — every modern browser, workerd, and Node 22+.
 *   2. `crypto.getRandomValues()` — older runtimes without `randomUUID` still
 *      ship Web Crypto's CSPRNG; hex-encode 16 bytes behind the prefix.
 *   3. `Date.now()` — no Web Crypto at all (very old/exotic runtime); acceptable
 *      because the id is a non-secret correlation handle, not a token.
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
const randomSessionId = (prefix = "sess"): string => {
    if (typeof crypto !== "undefined") {
        if (typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }

        if (typeof crypto.getRandomValues === "function") {
            const bytes = crypto.getRandomValues(new Uint8Array(16));

            return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        }
    }

    return `${prefix}-${Date.now().toString(36)}`;
};

export { randomSessionId };
