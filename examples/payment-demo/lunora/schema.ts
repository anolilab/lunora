import { paymentExtension } from "@lunora/payment";
import { defineSchema } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

/**
 * payment-demo schema.
 *
 * `@lunora/payment` ships its tables as a schema extension: `.extend(paymentExtension)`
 * merges them as `payment_customers`, `payment_events`, `payment_sessions`,
 * `payment_subscriptions` and `payment_usageEvents`. Codegen resolves the extension
 * from the installed package, so upgrading `@lunora/payment` is all it takes to pick
 * up a new column or index.
 */
export default defineSchema({}).extend(paymentExtension).extend(ratelimit.extension);
