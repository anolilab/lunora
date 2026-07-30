/**
 * The Cloudflare {@link DeployDriver} — the default target, and the reference
 * implementation of the seam.
 *
 * Deliberately thin. Every method delegates to the same `inferLunoraBindings` /
 * `reconcileWrangler*` functions the CLI called directly before the driver
 * existed, so routing a command through it is behavior-preserving by
 * construction rather than by careful re-implementation.
 *
 * The one piece of real work here is {@link toResourceGraph}: projecting the
 * Cloudflare-shaped `InferredBindings` down to the provider-neutral
 * {@link ResourceGraph}. That projection is lossy on purpose — it drops the
 * host encodings (binding names, DO class wiring, hint-only capabilities that
 * need un-mintable remote ids) and keeps only what a second target would also
 * need to know. `provision` therefore runs its own inference rather than
 * consuming the graph, because writing `wrangler.jsonc` needs exactly the
 * encodings the neutral graph discards — see the note on `DeployDriver`.
 */

import type { DeployDriver, DriverContext, DriverToolchain, NamedResource, ProvisionResult, ResourceGraph, ShardNamespaceResource } from "../deploy-driver";
import type { InferredBindings } from "../infer-bindings";
import { inferLunoraBindings } from "../infer-bindings";
import { reconcileWranglerBindings } from "./reconcile-bindings";
import { reconcileWranglerCompatibilityDate } from "./reconcile-compatibility-date";
import { reconcileWranglerCrons } from "./reconcile-crons";

/**
 * Project Cloudflare's `InferredBindings` onto the neutral {@link ResourceGraph}.
 *
 * Capabilities that are hint-only on Cloudflare (Hyperdrive, pipelines, and the
 * rest that need an un-mintable remote id) are intentionally absent: they are
 * not requirements a driver can provision, and modelling them neutrally would
 * imply a portability the graph cannot deliver.
 */
const toResourceGraph = (inferred: InferredBindings, crons: ReadonlyArray<string>): ResourceGraph => {
    const shardNamespaces: ShardNamespaceResource[] = inferred.durableObjects.map((durableObject) => {
        // A DO binding is only written for a class the worker entry exports, so
        // anything that reached this list is exported by construction.
        return { className: durableObject.className, exported: true, name: durableObject.binding };
    });

    const queues: NamedResource[] = inferred.queues.map((queue) => {
        return { name: queue.name };
    });
    const workflows: NamedResource[] = inferred.workflows.map((workflow) => {
        return { exported: workflow.exported, name: workflow.exportName };
    });
    const containers: NamedResource[] = inferred.containers.map((container) => {
        return { exported: container.exported, name: container.exportName };
    });

    return {
        containers,
        crons: [...crons],
        globalDatabase: inferred.needsD1,
        keyValueStore: inferred.usesKv,
        objectStorage: inferred.usesStorage,
        queues,
        shardNamespaces,
        signals: [...inferred.signals],
        workflows,
    };
};

/**
 * Reconcile one aspect of `wrangler.jsonc`, folding a thrown error into a
 * warning.
 *
 * Provisioning is best-effort by design: a failure to auto-write a binding must
 * not abort the command, because `validateWrangler` runs afterwards and is the
 * real gate on a genuinely-missing requirement. This mirrors the per-step
 * `try`/`catch` the CLI had inline before the driver existed.
 */
const reconcileStep = (label: string, step: () => { added?: string[]; changed: boolean; warnings?: string[]; wranglerPath?: string }): ProvisionResult => {
    try {
        const result = step();

        return {
            added: result.added ?? [],
            changed: result.changed,
            configPath: result.wranglerPath,
            warnings: result.warnings ?? [],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { added: [], changed: false, warnings: [`${label} skipped: ${message}`] };
    }
};

/**
 * Cloudflare's `wrangler` command surface.
 *
 * Each builder reproduces exactly the argv the CLI assembled inline before the
 * driver existed — including flag order, which keeps the change invisible to
 * the handlers' spawn assertions. `tool` is the bare binary: the CLI wraps it
 * for the project's package manager.
 */
const CLOUDFLARE_TOOLCHAIN: DriverToolchain = {
    deploy: (request) => {
        // `versions upload` publishes a new Version with a preview URL instead
        // of taking production traffic.
        const args: string[] = request.preview === true ? ["versions", "upload"] : ["deploy"];

        // Framework composition deploys a wrapper entry that overrides the
        // adapter-owned `main` in wrangler.jsonc.
        if (request.entry !== undefined) {
            args.push(request.entry);
        }

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        if (request.dryRun === true) {
            args.push("--dry-run");
        }

        // `--metafile` rides with `--outdir`: the esbuild metafile is what makes
        // the emitted bundle inspectable for CI artifacting.
        if (request.outDir !== undefined) {
            args.push("--outdir", request.outDir, "--metafile");
        }

        return { args, tool: "wrangler" };
    },

    dev: (request) => {
        const args: string[] = ["dev"];

        if (request.configPath !== undefined) {
            args.push("--config", request.configPath);
        }

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        args.push(...(request.extraArgs ?? []));

        return { args, tool: "wrangler" };
    },

    secretList: (request) => {
        const args: string[] = ["secret", "list", "--format", "json"];

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        return { args, tool: "wrangler" };
    },

    secretPut: (request) => {
        // The value is fed on stdin by the caller, never argv — so it stays out
        // of the process table and shell history.
        const args: string[] = ["secret", "put", request.key ?? ""];

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        return { args, tool: "wrangler" };
    },

    tail: (request) => {
        const args: string[] = ["tail"];

        if (request.worker !== undefined) {
            args.push(request.worker);
        }

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.format !== undefined) {
            args.push("--format", request.format);
        }

        if (request.status !== undefined) {
            args.push("--status", request.status);
        }

        if (request.search !== undefined) {
            args.push("--search", request.search);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        return { args, tool: "wrangler" };
    },
};

/** The Cloudflare deploy driver. */
const CLOUDFLARE_DRIVER: DeployDriver = {
    id: "cloudflare",

    infer: async (context: DriverContext) => {
        const inferred = await inferLunoraBindings({ projectRoot: context.projectRoot });

        return toResourceGraph(inferred, context.crons ?? []);
    },

    name: "Cloudflare",

    provision: async (context: DriverContext) => {
        const cronTriggers = context.crons ?? [];

        // Bindings. Re-infers rather than reading the neutral graph: writing
        // wrangler bindings needs the Cloudflare encodings the graph drops.
        const bindings = await (async (): Promise<ProvisionResult> => {
            try {
                const inferred = await inferLunoraBindings({ projectRoot: context.projectRoot });

                return reconcileStep("binding inference", () => reconcileWranglerBindings(context.projectRoot, inferred));
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);

                return { added: [], changed: false, warnings: [`binding inference skipped: ${message}`] };
            }
        })();

        // Compatibility date — bumped to the release that enables Workers Cache.
        const compatibility = reconcileStep("compatibility date sync", () => reconcileWranglerCompatibilityDate(context.projectRoot));
        // Cron triggers, from the crons codegen discovered in the app's code.
        const crons = reconcileStep("cron trigger sync", () => reconcileWranglerCrons(context.projectRoot, cronTriggers));

        // `reconcileWranglerBindings` names each binding it wrote; the other two
        // steps report only whether they changed, so label them here.
        const steps: ReadonlyArray<ProvisionResult> = [
            bindings,
            { ...compatibility, added: compatibility.changed ? ["compatibility_date"] : [] },
            { ...crons, added: crons.changed ? [`${String(cronTriggers.length)} cron trigger(s)`] : [] },
        ];

        return {
            added: steps.flatMap((step) => step.added),
            changed: steps.some((step) => step.changed),
            // Every step resolves the same wrangler file; report the first found.
            configPath: steps.find((step) => step.configPath !== undefined)?.configPath,
            warnings: steps.flatMap((step) => step.warnings),
        };
    },

    toolchain: CLOUDFLARE_TOOLCHAIN,
};

export default CLOUDFLARE_DRIVER;
