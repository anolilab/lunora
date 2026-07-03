/**
 * One committed `wrangler.jsonc` `vars` entry whose value is a plaintext secret —
 * the input the `plaintext_secret_in_wrangler_vars` lint consumes. The full value
 * is never carried; only a redacted {@link AdvisorWranglerVariable.preview}.
 * Produced by `@lunora/config` (which reads `wrangler.jsonc`) and threaded through
 * codegen; runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorWranglerVariable {
    /** The `wrangler.jsonc` file the var was read from, relative to the project root. */
    file: string;
    /** The offending `vars` key (e.g. `STRIPE_SECRET_KEY`). */
    key: string;
    /** Heuristic that matched, e.g. `stripe_live_key` / `private_key` / `secret_named_var`. */
    kind: string;
    /** Redacted preview (first few chars + length) — never the full secret. */
    preview: string;
}
