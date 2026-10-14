/**
 * The workflow deploy settings, in ONE table: each wrangler leaf path (as a
 * `workflows[]` binding and an `exports.<Class>` workflow both spell it) and
 * how to read it off a discovered `defineWorkflow`. The reconciler writes and
 * retunes through it and the validator compares through it, so a setting added
 * here is written, retuned, carried across a binding move and cross-checked
 * everywhere at once.
 */
import type { WorkflowIR } from "@lunora/codegen";

import { isPlainObject } from "./guards";

interface WorkflowSetting {
    /** The declaration's value, in wrangler's shape; `undefined` when not declared. */
    of: (workflow: WorkflowIR) => unknown;
    path: readonly [string] | readonly [string, string];
}

const WORKFLOW_SETTINGS: ReadonlyArray<WorkflowSetting> = [
    { of: (workflow) => (workflow.schedules === undefined ? undefined : [...workflow.schedules]), path: ["schedules"] },
    { of: (workflow) => workflow.limits?.steps, path: ["limits", "steps"] },
    { of: (workflow) => workflow.defaultRetention?.successRetention, path: ["default_retention", "success_retention"] },
    { of: (workflow) => workflow.defaultRetention?.errorRetention, path: ["default_retention", "error_retention"] },
];

/** The top-level keys those settings live under — what a binding moved into an export carries over. */
const WORKFLOW_SETTING_KEYS: ReadonlyArray<string> = [...new Set(WORKFLOW_SETTINGS.map(({ path }) => path[0]))];

/** Read a leaf path out of an untrusted parsed entry. */
const settingLeaf = (entry: unknown, path: ReadonlyArray<string>): unknown => {
    let node = entry;

    for (const key of path) {
        node = isPlainObject(node) ? node[key] : undefined;
    }

    return node;
};

/** The deploy settings a `defineWorkflow` declares, as a wrangler entry fragment. */
const workflowSettingsFor = (workflow: WorkflowIR): Record<string, unknown> => {
    const settings: Record<string, unknown> = {};

    for (const { of, path } of WORKFLOW_SETTINGS) {
        const value = of(workflow);

        if (value === undefined) {
            continue;
        }

        const [head, child] = path;

        settings[head] = child === undefined ? value : { ...(settings[head] as Record<string, unknown> | undefined), [child]: value };
    }

    return settings;
};

export type { WorkflowSetting };
export { settingLeaf, WORKFLOW_SETTING_KEYS, WORKFLOW_SETTINGS, workflowSettingsFor };
