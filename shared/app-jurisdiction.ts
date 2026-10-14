/**
 * The data-residency jurisdiction the app declared on its schema
 * (`.jurisdiction("eu")`), readable by code that reaches the app's Durable
 * Objects without going through the generated worker.
 *
 * The generated `_generated/app.ts` calls {@link declareAppJurisdiction} at
 * module scope, so every isolate that loads the worker script — the worker and
 * each Durable Object class exported from it — sees the declaration before any
 * request runs. `@lunora/mail` reads it with {@link getAppJurisdiction} and pins
 * its shard RPC the way the runtime pins `shardDO`, without the app threading the
 * value through by hand.
 *
 * Keyed on a `Symbol.for` global, so copies of this file inlined into separate
 * bundles (it is bundler-inlined, not a package) still share one slot.
 *
 * Deliberately **not** a package: keep it zero-dependency. Consumers drop
 * `outDir`/`rootDir` from their `tsconfig.json` (see `shared/` in AGENTS.md).
 */

/** Cloudflare Durable Object data-residency jurisdiction (widening union). */
type AppJurisdiction = "eu" | "fedramp" | "us";

const STATE_KEY = Symbol.for("lunora:app-jurisdiction");

const slot = globalThis as unknown as Record<symbol, AppJurisdiction | undefined>;

/**
 * Record the schema's jurisdiction for this isolate. Declaring a different one
 * than an earlier call throws: two residency constraints in one isolate means one
 * of them would be silently dropped.
 */
const declareAppJurisdiction = (jurisdiction: AppJurisdiction): void => {
    const current = slot[STATE_KEY];

    if (current !== undefined && current !== jurisdiction) {
        throw new TypeError(`lunora: the app jurisdiction is already "${current}"; refusing to redeclare it as "${jurisdiction}".`);
    }

    slot[STATE_KEY] = jurisdiction;
};

/** The jurisdiction the app declared, or `undefined` when it declared none. */
const getAppJurisdiction = (): AppJurisdiction | undefined => slot[STATE_KEY];

/** Forget the declaration. Tests only. */
const resetAppJurisdiction = (): void => {
    delete slot[STATE_KEY];
};

export { declareAppJurisdiction, getAppJurisdiction, resetAppJurisdiction };
export type { AppJurisdiction };
