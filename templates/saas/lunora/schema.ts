// lunora:add:saas:start
import { saas } from "./saas/schema";
// lunora:add:saas:end
// lunora:add:ratelimit:start
import { ratelimit } from "./ratelimit/schema";
// lunora:add:ratelimit:end
import { defineSchema } from "lunorash/server";

export const schema = defineSchema({})
    // lunora:add:ratelimit:start
    .extend(ratelimit.extension)
    // lunora:add:saas:start
    .extend(saas.extension);
// lunora:add:saas:end

// lunora:add:ratelimit:end
