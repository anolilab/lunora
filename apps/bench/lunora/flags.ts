/**
 * Feature flags — added by `lunora add flags`.
 *
 * Declares an OpenFeature-backed feature flag provider. Codegen discovers this
 * export and wires `ctx.flags` onto every query, mutation, and action context.
 *
 * Usage — every reader takes the fallback **positionally**, matching OpenFeature:
 *   const isEnabled = await ctx.flags.boolean("dark_mode", false);
 *   const pageSize  = await ctx.flags.number("page_size", 25);
 *   const greeting  = await ctx.flags.string("greeting", "Hello");
 *
 * For the evaluation reason / variant, use the `details` namespace:
 *   const { value, variant, reason } = await ctx.flags.details.boolean("dark_mode", false);
 *
 * The in-memory provider below needs no binding. For production flag management,
 * provision a Cloudflare Flagship account, add a `FLAGS` binding to
 * wrangler.jsonc, add `@cloudflare/flagship-binding` to your package.json, and
 * swap in `flagshipProvider({ binding: "FLAGS" })`.
 */
import { defineFlags } from "@lunora/flags";
import { memoryProvider } from "@lunora/flags/providers/memory";

export default defineFlags({
    /** Derive the OpenFeature targeting key from the authenticated user. */
    identify: (auth) => auth.userId ?? undefined,

    /**
     * Static in-memory provider, perfect for local dev. It takes a plain
     * `key → value` map — the value IS the flag's value, so `beta_features:
     * false` is a boolean flag that reads `false`. Wrapping it in a descriptor
     * object (`{ defaultValue: false, type: "boolean" }`) registers that OBJECT
     * as the value, and every typed read then falls back to its call-site
     * default forever.
     *
     * Swap to `flagshipProvider({ binding: "FLAGS" })` once you provision a
     * Cloudflare Flagship account for production.
     */
    provider: memoryProvider({
        beta_features: false,
        dark_mode: false,
        page_size: 25,
    }),
});
