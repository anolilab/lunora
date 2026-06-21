/**
 * One secret-shaped string literal discovered in the lunora source — the input
 * the `hardcoded_secret` lint consumes. The full value is never carried; only a
 * redacted {@link AdvisorSecretLiteral.preview}. Produced by the codegen feeder
 * (complementing the pre-commit `vis secrets` scan); runtime callers don't supply
 * it, so the lint finds nothing there.
 */
export interface AdvisorSecretLiteral {
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Heuristic that matched, e.g. `stripe_live_key` / `aws_access_key` / `private_key` / `high_entropy`. */
    kind: string;
    /** 1-based line of the literal, or `0` when unknown. */
    line: number;
    /** Redacted preview (first few chars + length) — never the full secret. */
    preview: string;
}
