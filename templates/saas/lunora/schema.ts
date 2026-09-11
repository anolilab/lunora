// lunora:add:saas:start
import { saas } from "./saas/schema";
// lunora:add:saas:end
// lunora:add:ratelimit:start
import { ratelimit } from "./ratelimit/schema";
// lunora:add:ratelimit:end
import { defineSchema } from "lunorash/server";

/**
 * Your tables go in the `defineSchema({ … })` call; the kit's arrive through the
 * managed `.extend()` blocks below, which `lunora registry add` maintains.
 *
 * The default export is load-bearing — codegen's generated `app.ts` and
 * `shard.ts` import this module's default.
 */
export default defineSchema({})
    // lunora:add:ratelimit:start
    .extend(ratelimit.extension)
    // lunora:add:ratelimit:end
    // lunora:add:saas:start
    .extend(saas.extension);
// lunora:add:saas:end
