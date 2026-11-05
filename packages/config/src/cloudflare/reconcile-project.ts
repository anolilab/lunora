/**
 * The best-effort wrangler reconcilers a bundler plugin runs at startup: binding
 * inference, cron triggers, and the compatibility date.
 *
 * They live beside the primitives they call (rather than in a plugin package)
 * because `@lunora/vite` and `@lunora/rspack` both need the identical pass, and a
 * second copy of a routine that WRITES `wrangler.jsonc` is a bug that has to be
 * fixed twice.
 */
import { basename } from "node:path";

import type { DiscoveryCache } from "../discovery-cache";
import { inferLunoraBindings } from "../infer-bindings";
import { LUNORA_TAG } from "../log-line";
import { applyWranglerBindings } from "./apply-bindings";
import type { ExportGap, WranglerBindingsPlan } from "./reconcile-bindings";
import { planWranglerBindings } from "./reconcile-bindings";
import { reconcileWranglerCompatibilityDate } from "./reconcile-compatibility-date";
import { describePreservedCrons, reconcileWranglerCrons } from "./reconcile-crons";

/** The project coordinates every reconciler here needs. */
interface ReconcileProject {
    /** Memoises the source scans, so a caller that also validates or reconciles again parses the project once. */
    cache?: DiscoveryCache;

    /** Absolute path to the project root holding `wrangler.jsonc`. */
    projectRoot: string;

    /** The schema directory, relative to `projectRoot` (usually `"lunora"`). */
    schemaDir: string;

    /** The deploy target; wrangler settings only Cloudflare reads are written only for `"cloudflare"` (or when omitted). */
    target?: string;
}

/** The two logger methods every reconciler here needs; `info` is optional on Vite's. */
interface ReconcileLogger {
    info?: (message: string) => void;
    warn: (message: string) => void;
}

/** Infer the project's bindings and plan their reconcile, writing nothing. */
const planProjectBindings = async (options: ReconcileProject): Promise<WranglerBindingsPlan> =>
    planWranglerBindings(
        options.projectRoot,
        await inferLunoraBindings({ cache: options.cache, projectRoot: options.projectRoot, schemaDir: options.schemaDir }),
        {
            target: options.target,
        },
    );

/**
 * Infer the Cloudflare bindings the project's code implies and reconcile them
 * into `wrangler.jsonc` (Durable Objects, their migration classes, and the
 * `DB` D1 binding for `.global()` schemas). Best-effort and idempotent — runs at
 * dev startup (and on every `@lunora/rspack` pass) so the user never hand-writes
 * binding boilerplate. A failure here must never abort codegen; the wrangler
 * validator reports real problems.
 *
 * `onExportGaps` (dev only) is invoked when a declared container/workflow isn't
 * re-exported by the worker entry, so the caller can raise it in the browser
 * error overlay in addition to the console warning.
 */
const reconcileBindingsSafely = async (
    options: ReconcileProject,
    logger: ReconcileLogger,
    onExportGaps?: (gaps: ReadonlyArray<ExportGap>) => void,
): Promise<void> => {
    try {
        const reconciled = applyWranglerBindings(options.projectRoot, await planProjectBindings(options));
        const target = reconciled.wranglerPath ?? "wrangler.jsonc";

        if (reconciled.added.length > 0) {
            logger.info?.(`${LUNORA_TAG} inferred bindings → ${reconciled.added.join(", ")} (written to ${target})`);
        }

        if (reconciled.updated.length > 0) {
            logger.info?.(`${LUNORA_TAG} updated bindings → ${reconciled.updated.join(", ")} (written to ${target})`);
        }

        if (reconciled.devConfig !== undefined) {
            const { added, path, updated } = reconciled.devConfig;

            logger.info?.(`${LUNORA_TAG} dev sidecar bindings → ${[...added, ...updated].join(", ")} (written to ${path})`);
        }

        for (const warning of reconciled.warnings) {
            logger.warn(`${LUNORA_TAG} ${warning}`);
        }

        if (reconciled.exportGaps.length > 0) {
            onExportGaps?.(reconciled.exportGaps);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`${LUNORA_TAG} binding inference skipped: ${message}`);
    }
};

/**
 * The bindings a {@link reconcileBindingsSafely} pass would add or retune right
 * now, as its log labels (a dev sidecar's prefixed with its file) — from the same plan, written
 * nowhere. For a dev server that provisions only at startup: a save that
 * declares a queue, reads `ctx.kv` or exports a workflow leaves the running
 * worker without that binding until the server restarts, and this is how the
 * watcher finds out. Empty when the config is in sync or the scan fails (a
 * half-typed source must not read as a change).
 *
 * `cache` is required: a watcher calls this on every save, and clears it when
 * the sources move.
 */
const pendingBindingChanges = async (options: ReconcileProject & { cache: DiscoveryCache }): Promise<string[]> => {
    try {
        const { added, devConfig, updated } = await planProjectBindings(options);
        // A sidecar label names its file: the binding goes there, not into wrangler.jsonc.
        const sidecar = devConfig === undefined ? [] : [...devConfig.added, ...devConfig.updated].map((label) => `${basename(devConfig.path)} ${label}`);

        return [...new Set([...added, ...updated, ...sidecar])];
    } catch {
        return [];
    }
};

/**
 * The preserved set last reported for a project root, so the `kept …` line is
 * news rather than a heartbeat.
 *
 * Cron reconciliation runs on EVERY codegen pass — which in dev is every schema
 * save — and the preserved set is almost always the same one it was a second
 * ago. Keyed by project root because one Vite process can host more than one.
 */
const lastPreserved = new Map<string, string>();

/** Reconcile cron triggers and the compatibility date into `wrangler.jsonc`. */
const reconcileWranglerExtras = (projectRoot: string, cronTriggers: ReadonlyArray<string>, logger: ReconcileLogger): void => {
    try {
        const reconciled = reconcileWranglerCrons(projectRoot, cronTriggers);

        if (reconciled.changed) {
            logger.info?.(`${LUNORA_TAG} synced ${cronTriggers.length.toFixed(0)} cron trigger(s) into ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
        }

        // A damaged `lunora.crons` degrades this to add-only silently — see
        // `ReconcileCronsResult.warnings`.
        for (const warning of reconciled.warnings) {
            logger.warn(`${LUNORA_TAG} ${warning}`);
        }

        // The array is not the codegen-derived set — worth saying, but only when
        // it is news: the config was just written, or the set itself moved.
        const preserved = reconciled.preserved.join("\u0000");
        const kept = describePreservedCrons(reconciled.preserved);

        if (kept !== undefined && (reconciled.changed || lastPreserved.get(projectRoot) !== preserved)) {
            logger.info?.(`${LUNORA_TAG} ${kept}`);
        }

        lastPreserved.set(projectRoot, preserved);
    } catch (cronError: unknown) {
        const message = cronError instanceof Error ? cronError.message : String(cronError);

        logger.warn(`${LUNORA_TAG} cron trigger sync skipped: ${message}`);
    }

    try {
        const reconciled = reconcileWranglerCompatibilityDate(projectRoot);

        if (reconciled.changed) {
            logger.info?.(
                `${LUNORA_TAG} bumped compatibility_date to ${reconciled.date ?? "unknown"} (Workers Cache enabled) → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`,
            );
        }
    } catch (dateError: unknown) {
        const message = dateError instanceof Error ? dateError.message : String(dateError);

        logger.warn(`${LUNORA_TAG} compatibility date sync skipped: ${message}`);
    }
};

export type { ReconcileProject };
export { pendingBindingChanges, reconcileBindingsSafely, reconcileWranglerExtras };
