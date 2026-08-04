/* eslint-disable no-secrets/no-secrets -- the doc comment quotes the lint's rule id `payment_webhook_wide_tolerance`, not a credential */

/**
 * One payment webhook-adapter construction (`createStripeAdapter` /
 * `createPolarAdapter` / `createAutumnAdapter` / `createDodoPaymentsAdapter`) —
 * the shared input for the `payment_webhook_wide_tolerance` lint. The adapters
 * verify a webhook's signed timestamp against a `webhookToleranceSeconds` replay
 * window (default 300s); an implausibly wide window leaves the endpoint accepting
 * stale, replayable signed payloads long after capture. `toleranceSeconds`
 * carries the statically-known literal (when present and a plain numeric
 * literal); the lint fires only above a conservative ceiling. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there.
 */
export interface AdvisorPaymentWebhook {
    /** The adapter factory invoked. */
    callee: "createAutumnAdapter" | "createDodoPaymentsAdapter" | "createPolarAdapter" | "createStripeAdapter";
    /** The exported binding name of the enclosing declaration (`<module>` at file scope). */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the construction, or `0` when unknown. */
    line: number;
    /** Statically-known `webhookToleranceSeconds` literal, when present and a plain numeric literal. */
    toleranceSeconds?: number;
}
