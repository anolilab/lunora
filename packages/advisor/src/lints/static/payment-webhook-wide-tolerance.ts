import emit from "../../finding";
import type { AdvisorPaymentWebhook } from "../../payment-webhooks";
import type { Lint } from "../../types";

/**
 * The `webhookToleranceSeconds` ceiling above which a replay window is treated as
 * implausibly wide: one hour. The adapters default to 300s (Stripe's and the
 * Standard Webhooks spec's recommendation); a legitimate clock-skew allowance is
 * seconds-to-low-minutes, so 3600s is well clear of any real skew and only a
 * deliberately (or accidentally) loosened window trips it.
 */
const WIDE_TOLERANCE_THRESHOLD_SECONDS = 60 * 60;

/**
 * Flags a payment webhook adapter (`createStripeAdapter` / `createPolarAdapter` /
 * `createAutumnAdapter` / `createDodoPaymentsAdapter`) configured with an
 * implausibly wide `webhookToleranceSeconds` replay window.
 *
 * The adapters reject a webhook whose signed timestamp is more than
 * `webhookToleranceSeconds` from now, so a captured-then-replayed signed payload
 * is refused once it ages past the window. The default (300s) is the recommended
 * clock-skew allowance; widening it to hours or days keeps stale, replayable
 * signed events valid long after capture, defeating the timestamp check and
 * re-opening the replay window the signature scheme exists to close.
 *
 * Runs only when the codegen feeder supplies adapter evidence
 * (`context.paymentWebhooks`); a runtime caller flags nothing. Fires only on a
 * statically-known numeric `webhookToleranceSeconds` literal above the ceiling —
 * a computed or env-sourced value is not evaluated, to keep the false-positive
 * rate low. One finding per matching adapter.
 */
const paymentWebhookWideTolerance: Lint = {
    categories: ["SECURITY"],
    description:
        "A payment webhook adapter configured with an implausibly wide `webhookToleranceSeconds` (over an hour). The timestamp tolerance is the webhook replay window; widening it far past the 300s default keeps captured signed events replayable long after capture, defeating the replay check.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "payment_webhook_wide_tolerance",
    remediation:
        "Keep `webhookToleranceSeconds` at or near the 300s default — just enough for clock skew. If a wide window was set to work around retries or backfills, handle those with idempotency on the event id instead, not by loosening the replay-window guard.",
    run: (context) => {
        if (context.paymentWebhooks === undefined) {
            return [];
        }

        const isWide = (row: AdvisorPaymentWebhook): boolean => row.toleranceSeconds !== undefined && row.toleranceSeconds >= WIDE_TOLERANCE_THRESHOLD_SECONDS;

        return context.paymentWebhooks
            .filter((row) => isWide(row))
            .map((row) => {
                const location = `\`${row.exportName}\` (${row.file}:${row.line.toString()})`;

                return emit(paymentWebhookWideTolerance, {
                    cacheKey: `payment_webhook_wide_tolerance:${row.file}:${row.line.toString()}`,
                    detail: `\`${row.callee}\` in ${location} sets \`webhookToleranceSeconds\` to ${(row.toleranceSeconds ?? 0).toString()}s (default 300s). That replay window keeps captured signed events valid long after capture.`,
                    metadata: {
                        callee: row.callee,
                        exportName: row.exportName,
                        file: row.file,
                        line: row.line,
                        toleranceSeconds: row.toleranceSeconds,
                    },
                });
            });
    },
    source: "static",
    title: "Payment webhook replay-tolerance window is implausibly wide",
};

export default paymentWebhookWideTolerance;
