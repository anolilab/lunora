import { inferLunoraBindings } from "@lunora/config";
import type { ExportGap } from "@lunora/config/cloudflare";
import { describePreservedCrons, reconcileWranglerBindings, reconcileWranglerCompatibilityDate } from "@lunora/config/cloudflare";

import { reconcileWranglerCrons } from "./cron-sync";
import { LUNORA_TAG } from "./log";
import type { ResolvedLunoraPluginOptions } from "./types";

/** The two logger methods every reconciler here needs; `info` is optional on Vite's. */
interface ReconcileLogger {
    info?: (message: string) => void;
    warn: (message: string) => void;
}

/**
 * Infer the Cloudflare bindings the project's code implies and reconcile them
 * into `wrangler.jsonc` (Durable Objects, their migration classes, and the
 * `DB` D1 binding for `.global()` schemas). Best-effort and idempotent — runs
 * once at startup so the user never hand-writes binding boilerplate. A failure
 * here must never abort codegen; the wrangler validator reports real problems.
 *
 * `onExportGaps` (dev only) is invoked when a declared container/workflow isn't
 * re-exported by the worker entry, so the caller can raise it in the browser
 * error overlay in addition to the console warning.
 */
const reconcileBindingsSafely = async (
    options: Pick<ResolvedLunoraPluginOptions, "projectRoot" | "schemaDir">,
    logger: ReconcileLogger,
    onExportGaps?: (gaps: ReadonlyArray<ExportGap>) => void,
): Promise<void> => {
    try {
        const inferred = await inferLunoraBindings({ projectRoot: options.projectRoot, schemaDir: options.schemaDir });
        const reconciled = reconcileWranglerBindings(options.projectRoot, inferred);

        const target = reconciled.wranglerPath ?? "wrangler.jsonc";

        if (reconciled.added.length > 0) {
            logger.info?.(`${LUNORA_TAG} inferred bindings → ${reconciled.added.join(", ")} (written to ${target})`);
        }

        if (reconciled.updated.length > 0) {
            logger.info?.(`${LUNORA_TAG} updated bindings → ${reconciled.updated.join(", ")} (written to ${target})`);
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
 * The preserved set last reported for a project root, so the `kept …` line is
 * news rather than a heartbeat.
 *
 * Cron reconciliation runs on EVERY codegen pass — which in dev is every schema
 * save — and the preserved set is almost always the same one it was a second
 * ago. Keyed by project root because one Vite process can host more than one.
 */
const lastPreserved = new Map<string, string>();

/**
 * Reconcile cron triggers and compatibility date into wrangler.jsonc.
 * Extracted from the plugin so it stays a plugin rather than a reconciler.
 */
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

export { reconcileBindingsSafely, reconcileWranglerExtras };
