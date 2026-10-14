import { LunoraPaymentError } from "../errors";

/**
 * Build a provider's `notSupported(operation)` thrower. A Merchant-of-Record owns the money movement,
 * so operations like manual authorize/capture (and, for some, refunds) have no API surface — calling
 * one throws a `PROVIDER_ERROR` naming the provider and the unsupported operation.
 */
const makeNotSupported =
    (label: string) =>
    (operation: string): never => {
        throw new LunoraPaymentError("PROVIDER_ERROR", `${label} does not support ${operation}`);
    };

export default makeNotSupported;
