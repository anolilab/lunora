/**
 * The writing half of the binding reconcile: {@link applyWranglerBindings}
 * puts a {@link planWranglerBindings} plan on disk — `wrangler.jsonc`, the dev
 * sidecar's config, then the ownership records — and
 * {@link reconcileWranglerBindings} plans and applies in one pass.
 */
import { writeFileSync } from "node:fs";

import type { InferredBindings } from "../infer-bindings";
import { readManifest } from "./lunora-manifest";
import type { ReconcileBindingsResult, WranglerBindingsPlan } from "./reconcile-bindings";
import { planWranglerBindings } from "./reconcile-bindings";

/** The labels a plan's dev sidecar rewrite carries, or `undefined` when it changes no binding. */
const devConfigLabels = (devConfig: WranglerBindingsPlan["devConfig"]): ReconcileBindingsResult["devConfig"] =>
    devConfig === undefined || (devConfig.added.length === 0 && devConfig.updated.length === 0)
        ? undefined
        : { added: devConfig.added, path: devConfig.path, updated: devConfig.updated };

/** Write each record of `edit`, answering a warning for each that failed. */
const recordOwnership = (projectRoot: string, edit: NonNullable<WranglerBindingsPlan["edit"]>, wranglerChanged: boolean): string[] => {
    const { manifest } = edit;

    if (manifest === undefined) {
        return [];
    }

    const warnings: string[] = [];

    for (const record of edit.records) {
        // Its own failure, not the caller's "binding inference skipped": the
        // config change it describes may already be on disk.
        try {
            // Re-read per record: each write starts from the file as the last
            // one left it, or the second would drop the key the first wrote.
            record.write(readManifest(projectRoot) ?? manifest);
        } catch (error: unknown) {
            warnings.push(
                `${wranglerChanged ? "wrangler.jsonc was updated, but " : ""}recording the ${record.label} reconcile owns in ${manifest.path} (lunora.${record.key}) failed: ${error instanceof Error ? error.message : String(error)}. Until it is recorded, ${record.consequence}.`,
            );
        }
    }

    return warnings;
};

/**
 * Write what {@link planWranglerBindings} planned: `wrangler.jsonc` when it
 * changes, the dev sidecar's config when it changes, and then the ownership
 * records.
 */
const applyWranglerBindings = (projectRoot: string, plan: WranglerBindingsPlan): ReconcileBindingsResult => {
    const { edit, ...summary } = plan;
    const devConfig = devConfigLabels(plan.devConfig);

    if (edit === undefined || plan.wranglerPath === undefined) {
        return { ...summary, changed: false, devConfig };
    }

    const warnings = [...plan.warnings];
    const wranglerChanged = edit.text !== edit.original;

    if (wranglerChanged) {
        writeFileSync(plan.wranglerPath, edit.text, "utf8");
    }

    if (plan.devConfig !== undefined && plan.devConfig.text !== plan.devConfig.original) {
        writeFileSync(plan.devConfig.path, plan.devConfig.text, "utf8");
    }

    // Ownership is recorded only once the config it describes is on disk, never
    // before: a record ahead of the file would let the next pass remove a field
    // this one never managed to write.
    warnings.push(...recordOwnership(projectRoot, edit, wranglerChanged));

    return {
        ...summary,
        changed: wranglerChanged,
        devConfig,
        ...(wranglerChanged ? {} : { reason: "bindings already in sync" }),
        warnings,
    };
};

/** Plan and apply in one pass: what `lunora deploy` and the dev-start reconcile run. */
const reconcileWranglerBindings = (
    projectRoot: string,
    inferred: InferredBindings,
    options: { environment?: string; target?: string } = {},
): ReconcileBindingsResult => applyWranglerBindings(projectRoot, planWranglerBindings(projectRoot, inferred, options));

export { applyWranglerBindings, reconcileWranglerBindings };
