type PaymentErrorCode =
    | "CONFIG_INVALID"
    | "CURRENCY_MISMATCH"
    | "FORBIDDEN"
    | "INVALID_TRANSITION"
    | "NOT_FOUND"
    | "PROVIDER_ERROR"
    | "WEBHOOK_SIGNATURE_INVALID"
    | "WEBHOOK_TIMESTAMP_INVALID";

const STATUS_BY_CODE: Record<PaymentErrorCode, number> = {
    CONFIG_INVALID: 500,
    CURRENCY_MISMATCH: 400,
    FORBIDDEN: 403,
    INVALID_TRANSITION: 409,
    NOT_FOUND: 404,
    PROVIDER_ERROR: 502,
    WEBHOOK_SIGNATURE_INVALID: 400,
    WEBHOOK_TIMESTAMP_INVALID: 400,
};

/** Typed error for all `@cirrus/payment` failures. `status` maps onto an HTTP response. */
class CirrusPaymentError extends Error {
    public readonly code: PaymentErrorCode;

    public readonly status: number;

    public constructor(code: PaymentErrorCode, message: string) {
        super(message);
        this.name = "CirrusPaymentError";
        this.code = code;
        this.status = STATUS_BY_CODE[code];
    }
}

export { CirrusPaymentError };
export type { PaymentErrorCode };
