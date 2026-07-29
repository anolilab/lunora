/**
 * `@lunora/deploy-alchemy` — an [Alchemy](https://alchemy.run)-backed
 * {@link DeployDriver}.
 *
 * # Why this is not part of `@lunora/config`
 *
 * `alchemy@0.93` has thirty dependencies, nine of them Node-shaped —
 * `wrangler`, `miniflare`, `esbuild`, `execa`, `find-process`, `glob`, `open`,
 * `proper-lockfile`, `signal-exit`. `@lunora/config` is imported by
 * `@lunora/vite`, so registering this driver there would push that tree into
 * every project that merely wanted to read `lunora.json`, and into any bundle
 * targeting workerd — where none of it survives.
 *
 * So it ships separately and registers itself: install the package, import it
 * once, and `--target alchemy` resolves. Projects that do not install it are
 * unaffected, and `@lunora/config` keeps a dependency footprint a Worker can
 * carry.
 *
 * # Why Alchemy rather than wrangler
 *
 * Wrangler deploys *one worker*. It has no model of the resources around it —
 * the D1 database, the R2 bucket, the queue — beyond what a human already
 * wrote into `wrangler.jsonc`, and no model at all of what should happen when
 * a project is deleted. That is why teardown is conventionally a best-effort
 * sweep over names, and why a non-empty bucket leaks.
 *
 * Alchemy models resources with explicit create/update/delete lifecycles and a
 * state store, which buys three things wrangler cannot:
 *
 * Provider breadth — Neon and PlanetScale (branchable Postgres/MySQL), Upstash,
 * S3, Vercel, AWS — which directly serves database branching for preview
 * environments. State that is explicit and diffable, instead of implicit in
 * naming conventions. And a destroy that actually works, because the resources
 * are lifecycle-managed rather than convention-named.
 *
 * It does **not** replace wrangler for the Workers-for-Platforms path:
 * Alchemy's Cloudflare provider is regular-Worker-shaped, and dispatch-namespace
 * uploads stay on their own API surface.
 *
 * # Pinning
 *
 * Pinned to `0.93.x`. Alchemy's `next` line (2.x) is a rewrite on Effect with a
 * narrower provider matrix — no Vercel, no Upstash — and the provider breadth
 * is the whole reason to adopt it. Revisiting 2.x is a swap behind this driver,
 * not a migration, which is the point of keeping the seam.
 */
import type { DeployDriver, DriverContext, ProvisionResult, ResourceGraph, ToolchainCommand } from "@lunora/config";
import { CLOUDFLARE_DRIVER, registerDeployDriver } from "@lunora/config";

/** The target id this driver serves. Selected with `--target alchemy` or `"target"` in `lunora.json`. */
const ALCHEMY_TARGET = "alchemy";

/**
 * The Alchemy entry program, relative to the project root.
 *
 * Alchemy is a library, not a config format: deploying means *running a
 * program* that declares resources. The CLI wraps that, so the driver only has
 * to name the file.
 */
const ALCHEMY_ENTRY = "alchemy.run.ts";

/**
 * Build an `alchemy` CLI invocation.
 *
 * Only argv is built here, never spawned — the CLI owns process concerns
 * (package-manager resolution, the injected spawner its tests substitute), so
 * this stays a pure function.
 */
const alchemyCommand = (subcommand: string, extra: ReadonlyArray<string> = []): ToolchainCommand => {
    return {
        args: [subcommand, ALCHEMY_ENTRY, ...extra],
        tool: "alchemy",
    };
};

/**
 * Alchemy's `--stage` is the closest thing it has to a deploy environment, and
 * an unset stage means its own default rather than an empty one.
 */
const stageArgs = (environment: string | undefined): ReadonlyArray<string> => (environment === undefined ? [] : ["--stage", environment]);

/**
 * The Alchemy-backed driver.
 *
 * Inference is *shared*, not reimplemented: what an app needs — shard
 * namespaces, queues, a bucket — falls out of its schema and imports, and every
 * target reaches the same conclusion. Only the emission differs. So this
 * delegates `infer` to the Cloudflare driver and diverges from `provision`
 * onward, which is exactly the split `ResourceGraph` exists to make possible.
 */
const ALCHEMY_DRIVER: DeployDriver = {
    id: ALCHEMY_TARGET,

    infer: async (context: DriverContext): Promise<ResourceGraph> => CLOUDFLARE_DRIVER.infer(context),

    name: "Alchemy",

    /**
     * Alchemy provisions at converge time, from the program — there is no
     * config file to reconcile ahead of it.
     *
     * Reporting `changed: false` is therefore accurate rather than a stub: this
     * step genuinely does nothing, and the resources appear when `alchemy
     * deploy` runs. Writing a `wrangler.jsonc` here would be worse than doing
     * nothing, because it would then be a second, stale source of truth about
     * what the project has.
     */
    provision: (): Promise<ProvisionResult> =>
        Promise.resolve({
            added: [],
            changed: false,
            warnings: [],
        }),

    // Node-only, and the reason this package exists: see the module docstring.
    runtime: "node",

    toolchain: {
        deploy: (request) => alchemyCommand("deploy", [...stageArgs(request.environment), ...(request.dryRun === true ? ["--dry-run"] : [])]),
        dev: (request) => alchemyCommand("dev", stageArgs(request.environment)),
        secretList: () => undefined,
        secretPut: () => undefined,
        tail: () => undefined,
    },
};

/**
 * Register the driver so `--target alchemy` resolves.
 *
 * Explicit rather than an import side effect: a package that registers itself
 * merely by being imported is impossible to import for its types alone, and
 * makes load order load-bearing.
 */
const useAlchemyDeployDriver = (): DeployDriver => {
    registerDeployDriver(ALCHEMY_DRIVER);

    return ALCHEMY_DRIVER;
};

export { ALCHEMY_DRIVER, ALCHEMY_ENTRY, ALCHEMY_TARGET, useAlchemyDeployDriver };
