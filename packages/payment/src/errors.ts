import { LunoraError } from "@lunora/errors";

/**
 * `PaymentErrorCode` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
type PaymentErrorCode =
    | "CONFIG_INVALID"
    | "CURRENCY_MISMATCH"
    | "FORBIDDEN"
    | "INVALID_TRANSITION"
    | "NOT_FOUND"
    | "PROVIDER_ERROR"
    | "WEBHOOK_EVENT_ID_MISSING"
    | "WEBHOOK_SIGNATURE_INVALID"
    | "WEBHOOK_TIMESTAMP_INVALID";

const STATUS_BY_CODE: Record<PaymentErrorCode, number> = {
    CONFIG_INVALID: 500,
    CURRENCY_MISMATCH: 400,
    FORBIDDEN: 403,
    INVALID_TRANSITION: 409,
    NOT_FOUND: 404,
    PROVIDER_ERROR: 502,
    WEBHOOK_EVENT_ID_MISSING: 400,
    WEBHOOK_SIGNATURE_INVALID: 400,
    WEBHOOK_TIMESTAMP_INVALID: 400,
};

/**
 * Typed error for all `@lunora/payment` failures. A `LunoraError` subclass; `status` maps onto an HTTP response.
 * @experimental
 */
class LunoraPaymentError extends LunoraError {
    // Narrow the inherited `code` to the payment taxonomy (base sets it).
    declare public readonly code: PaymentErrorCode;

    public constructor(code: PaymentErrorCode, message: string) {
        super(code, message, { name: "LunoraPaymentError", status: STATUS_BY_CODE[code] });
    }
}

export { LunoraPaymentError };
export type { PaymentErrorCode };
