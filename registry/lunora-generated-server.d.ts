/**
 * Ambient stub for `#lunora/_generated/server.js` — the per-app builder module
 * `lunora codegen` emits into a real project — so the function templates that
 * import it type-check standalone under `registry/tsconfig.json`.
 *
 * WHY THIS EXISTS. Without it every item that imports the builders had to be
 * listed in that tsconfig's `exclude`, which is where a batch of shipped defects
 * hid: a `ctx.request` that no context has ever carried, a `sql` tagged template
 * on a `SqlClient` that only exposes `.query`, and a `ctx.flags.number(key, {
 * defaultValue })` call whose real signature takes the default positionally.
 * `#lunora/…` is a non-relative specifier, so an ambient module declaration
 * matches it (a relative one — `crons`' `./_generated/api` — genuinely cannot be
 * stubbed, and stays excluded).
 *
 * WHAT IT IS NOT. The real emitted module narrows every table name, document
 * shape, and id to the app's own `defineSchema`. This stub keeps the base,
 * table-name-generic `@lunora/server` contexts, so it proves an item's imports,
 * `ctx.*` surface, and package call signatures — not that a `ctx.db.query("…")`
 * names a table the consumer declared. Keep it deliberately thin: every field
 * here must exist on the generated context, or the gate lies.
 */
declare module "#lunora/_generated/server.js" {
    /**
     * Facades codegen weaves onto every context when the app declares
     * `lunora/flags.ts`. Optional on the stub would be a lie in the other
     * direction (items legitimately read them unguarded), so they are required.
     */
    interface WovenEveryCtx {
        readonly flags: import("@lunora/flags").LunoraFlags;
    }

    /** Facades codegen weaves onto ActionCtx only — non-deterministic external I/O. */
    interface WovenActionCtx extends WovenEveryCtx {
        readonly ai: import("@lunora/ai").LunoraAi;
        readonly browser: import("@lunora/browser").Browser;
        readonly payments: import("@lunora/payment").LunoraPayment;
        readonly sql: import("@lunora/hyperdrive").SqlClient;
    }

    export type QueryCtx = WovenEveryCtx & import("@lunora/server").QueryCtx;
    export type MutationCtx = WovenEveryCtx & import("@lunora/server").MutationCtx;
    export type ActionCtx = WovenActionCtx & import("@lunora/server").ActionCtx;

    export const query: import("@lunora/server").QueryBuilder<QueryCtx, import("@lunora/server").EmptyArgs>;
    export const mutation: import("@lunora/server").MutationBuilder<MutationCtx, import("@lunora/server").EmptyArgs>;
    export const action: import("@lunora/server").ActionBuilder<ActionCtx, import("@lunora/server").EmptyArgs>;
    export const internalQuery: import("@lunora/server").InternalQueryBuilder<QueryCtx, import("@lunora/server").EmptyArgs>;
    export const internalMutation: import("@lunora/server").InternalMutationBuilder<MutationCtx, import("@lunora/server").EmptyArgs>;
    export const internalAction: import("@lunora/server").InternalActionBuilder<ActionCtx, import("@lunora/server").EmptyArgs>;

    /** The validator builder. The generated one additionally narrows `v.id(table)` to the app's tables. */
    export const v: typeof import("@lunora/server").v;

    /**
     * The data-model types the real `_generated/server.ts` re-exports from its
     * sibling `_generated/dataModel.ts` (`export type { …, Doc, Id, … }`).
     *
     * `Id` is the emitted definition, which is already table-name-generic — the
     * brand carries the name, nothing narrows per app. `Doc` cannot be: the real
     * one resolves a table name through the app's own `DataModel`, and this stub
     * has no `defineSchema` to resolve against. It is therefore the BASE row
     * shape — exactly what `TableReader`'s `Row` defaults to and what
     * `DatabaseReader.get` returns here — so an item annotating a handler
     * `Promise<Doc<"widgets">[]>` type-checks against the base `ctx.db`, and the
     * per-column narrowing happens in the consumer's project where the schema
     * exists. The table parameter is accepted and deliberately unused: dropping it
     * would make every item's `Doc<"table">` a TS2315 here and correct there.
     */
    export type Id<TName extends string> = import("@lunora/server").Id<TName>;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above: the name is part of the real signature and has nothing to narrow on the stub
    export type Doc<TName extends string> = Record<string, unknown>;

    /**
     * The project's Cloudflare bindings, mirroring what `emit.ts` writes into
     * every real `_generated/server.ts`: an open index signature, because the
     * bindings a project configures in wrangler (R2/KV/D1/vars/secrets/…) are not
     * statically visible to codegen.
     *
     * This is the type every item narrows `cloudflare:workers`' `env` through.
     * That module's own `env` is `Cloudflare.Env`, which `@cloudflare/workers-types`
     * declares EMPTY and a project fills in only by running `wrangler types` — so
     * indexing it directly is a `tsc` error in any scaffold that has not.
     */
    export interface CloudflareBindings {
        readonly [binding: string]: unknown;
    }

    /** Alias for {@link CloudflareBindings} — the typed shape of `env`. */
    export type Env = CloudflareBindings;
}
