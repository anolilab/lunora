/**
 * Single source of truth for the workflow facts both the wrangler validator and
 * binding inference need — mirrors `container-info.ts`: derive the facts from
 * one `@lunora/codegen` discovery call so inference and validation can never
 * disagree about what `lunora/workflows.ts` declares.
 */
import type { WorkflowIR } from "@lunora/codegen";
import { discoverWorkflows, WORKFLOWS_FILENAME } from "@lunora/codegen";

import { discoverIr } from "./discover-info";

interface DiscoverWorkflowInfoResult {
    /** Parse error message, when `lunora/workflows.ts` exists but could not be analyzed. */
    error?: string;
    /** Discovered workflow definitions; `[]` when none are declared or parsing failed. */
    workflows: ReadonlyArray<WorkflowIR>;
}

/**
 * Discover the project's `defineWorkflow` declarations. Returns
 * `{ workflows: [] }` when the project has no `lunora/workflows.ts` (not an
 * error), or `{ workflows: [], error }` when the file exists but could not be
 * parsed — callers decide whether that is a warning (validator) or ignorable
 * (inference).
 */
const discoverWorkflowInfo = (projectRoot: string, schemaDirectory: string): DiscoverWorkflowInfoResult => {
    const { error, value } = discoverIr(projectRoot, schemaDirectory, WORKFLOWS_FILENAME, discoverWorkflows);

    return error === undefined ? { workflows: value ?? [] } : { error, workflows: [] };
};

export type { DiscoverWorkflowInfoResult };
export { discoverWorkflowInfo };

export { type WorkflowIR } from "@lunora/codegen";
