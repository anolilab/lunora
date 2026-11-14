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
const recordOwnership = (
    projectRoot: string,
    edit: NonNullable<WranglerBindingsPlan["edit"]>,
    { devConfigWritten, wranglerChanged }: { devConfigWritten: boolean; wranglerChanged: boolean },
): string[] => {
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
            record.write(readManifest(projectRoot) ?? manifest, { devConfigWritten });
        } catch (error: unknown) {
            warnings.push(
                `${wranglerChanged ? "wrangler.jsonc was updated, but " : ""}recording the ${record.label} reconcile owns in ${manifest.path} (lunora.${record.key}) failed: ${error instanceof Error ? error.message : String(error)}. Until it is recorded, ${record.consequence}.`,
            );
        }
    }

    return warnings;
};

/** Write the dev sidecar's config when the plan changes it, answering the failure rather than throwing it. */
const writeDevConfig = (devConfig: WranglerBindingsPlan["devConfig"], wranglerChanged: boolean): string | undefined => {
    if (devConfig === undefined || devConfig.text === devConfig.original) {
        return undefined;
    }

    try {
        writeFileSync(devConfig.path, devConfig.text, "utf8");

        return undefined;
    } catch (error: unknown) {
        return `${wranglerChanged ? "wrangler.jsonc was updated, but " : ""}writing ${devConfig.path} failed: ${error instanceof Error ? error.message : String(error)}. The dev sidecar keeps its previous service bindings until the next reconcile writes it.`;
    }
};

/**
 * Write what {@link planWranglerBindings} planned: `wrangler.jsonc` when it
 * changes, the dev sidecar's config when it changes, and then the ownership
 * records.
 */
const applyWranglerBindings = (projectRoot: string, plan: WranglerBindingsPlan): ReconcileBindingsResult => {
    const { edit, ...summary } = plan;

    if (edit === undefined || plan.wranglerPath === undefined) {
        return { ...summary, changed: false, devConfig: devConfigLabels(plan.devConfig) };
    }

    const warnings = [...plan.warnings];
    const wranglerChanged = edit.text !== edit.original;

    if (wranglerChanged) {
        writeFileSync(plan.wranglerPath, edit.text, "utf8");
    }

    // A failed sidecar write must not skip the records below: the bindings
    // already written to `wrangler.jsonc` would stay unowned, so every later pass
    // would read them as hand-written and never manage or remove them.
    const devConfigFailure = writeDevConfig(plan.devConfig, wranglerChanged);

    if (devConfigFailure !== undefined) {
        warnings.push(devConfigFailure);
    }

    // Ownership is recorded only once the config it describes is on disk, never
    // before: a record ahead of the file would let the next pass remove a field
    // this one never managed to write.
    warnings.push(...recordOwnership(projectRoot, edit, { devConfigWritten: devConfigFailure === undefined, wranglerChanged }));

    return {
        ...summary,
        changed: wranglerChanged,
        devConfig: devConfigFailure === undefined ? devConfigLabels(plan.devConfig) : undefined,
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
