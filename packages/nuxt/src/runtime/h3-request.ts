/**
 * Resolve the inbound web `Request` from an H3 event across the h3 v1 → v2 break.
 *
 * v1 exposes `toWebRequest(event)`; the v2 web-standards rewrite removed it and
 * carries the web `Request` directly as `event.req`. The `@lunora/nuxt` peer is
 * `h3: "^1.15.0"` (v1 — what Nuxt 4 / Nitro 2 run today); the v2 `event.req`
 * branch is forward-compat for when a stable h3 v2 ships and the peer widens. We
 * feature-detect `toWebRequest` at runtime rather than importing it statically —
 * a named `import { toWebRequest }` would throw at module-eval under v2 (missing export).
 *
 * Kept as a pure helper (the `h3` namespace + event in, a `Request` out) so both
 * branches are unit-tested without booting Nitro or installing a second h3 major.
 */
// `toWebRequest` is typed `unknown` (not a call signature) so the real `h3`
// namespace — whose `toWebRequest` takes a narrow `H3Event` — stays assignable
// under `strictFunctionTypes`; we re-narrow it to a `Request` factory at the call.
interface H3RequestNamespace {
    toWebRequest?: unknown;
}

const resolveWebRequest = (h3: H3RequestNamespace, event: unknown): Request =>
    typeof h3.toWebRequest === "function"
        ? (h3.toWebRequest as (event: unknown) => Request)(event) // h3 v1
        : (event as { req: Request }).req; // h3 v2 — `event.req` is the web Request

export type { H3RequestNamespace };
export { resolveWebRequest };
