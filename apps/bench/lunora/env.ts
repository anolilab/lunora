/**
 * The configuration functions read through `ctx.env`.
 *
 * Without a `defineEnv` contract in this file, `ctx.env` is undefined at runtime,
 * though it type-checks as an optional record. A cast such as
 * `ctx.env as unknown as { KEY?: string }` therefore compiles and reads nothing.
 * Codegen applies this accessor to the Worker's `env` on every context, and
 * each key is validated lazily on first read, so an unset optional key costs
 * nothing until a function reads it.
 *
 * The keys are those of the generated heavy-SDK domains (`scripts/generate.mjs
 * --heavy-share`). Each is optional, and the actions that need one refuse until
 * it is set (see `.dev.vars.example`).
 */
import { defineEnv, v } from "lunorash/server";

export const env = defineEnv({
    E2B_API_KEY: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    S3_ACCESS_KEY_ID: v.optional(v.string()),
    S3_BUCKET: v.optional(v.string()),
    S3_ENDPOINT: v.optional(v.string()),
    S3_SECRET_ACCESS_KEY: v.optional(v.string()),
});
