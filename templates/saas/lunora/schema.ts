// lunora:add:presence:start
import { presence } from "./presence/schema";
// lunora:add:presence:end
// lunora:add:saas:start
import { saas } from "./saas/schema";
// lunora:add:saas:end
// lunora:add:ratelimit:start
import { ratelimit } from "./ratelimit/schema";
// lunora:add:ratelimit:end
import { paymentExtension } from "@lunora/payment";
import { defineSchema } from "lunorash/server";

/**
 * Your tables go in the `defineSchema({ … })` call; the kit's arrive through the
 * managed `.extend()` blocks below, which `lunora registry add` maintains.
 *
 * The default export is load-bearing — codegen's generated `app.ts` and
 * `shard.ts` import this module's default.
 */
export default defineSchema({})
    /*
     * The payment store's tables, as the package's own schema extension: the store
     * reads and writes them as `payment_customers`, `payment_sessions`,
     * `payment_subscriptions`, … — names, columns and indexes that live in
     * `@lunora/payment`, so an upgrade brings a new column with no edit here.
     * Copying them inline instead drifts from what the store writes, and a
     * column type that disagrees (money is stored as numbers) fails every
     * payment write.
     *
     * They are root-scoped rather than `.shardBy("referenceId")`, and that is a
     * deliberate asymmetry with the rest of this app. A provider webhook arrives
     * with no session and no tenant — there is nothing to resolve a shard from —
     * so billing rows live at the root and carry the tenant in `referenceId`
     * instead. The organization id goes in that field (see `lunora/server.ts`),
     * which is what keeps a subscription tenant-scoped logically even though it
     * is not tenant-sharded physically.
     */
    .extend(paymentExtension)
    // lunora:add:ratelimit:start
    .extend(ratelimit.extension)
    // lunora:add:ratelimit:end
    // lunora:add:saas:start
    .extend(saas.extension)
    // lunora:add:saas:end
    // lunora:add:presence:start
    .extend(presence.extension);
// lunora:add:presence:end
