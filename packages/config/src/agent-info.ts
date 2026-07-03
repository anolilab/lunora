/**
 * Single source of truth for the agent facts both the wrangler validator and
 * binding inference need — mirrors `workflow-info.ts`: derive the facts from one
 * `@lunora/codegen` discovery call so inference and validation can never
 * disagree about what `lunora/agents.ts` declares. An agent compiles onto a
 * Cloudflare Workflow, so its wrangler footprint is a `workflows[]` entry.
 */
import { existsSync } from "node:fs";

import type { AgentIR } from "@lunora/codegen";
import { AGENTS_FILENAME, discoverAgents } from "@lunora/codegen";
import { Project } from "ts-morph";

import join from "./path";

interface DiscoverAgentInfoResult {
    /** Discovered agent definitions; `[]` when none are declared or parsing failed. */
    agents: ReadonlyArray<AgentIR>;
    /** Parse error message, when `lunora/agents.ts` exists but could not be analyzed. */
    error?: string;
}

/**
 * Discover the project's `defineAgent` declarations. Returns `{ agents: [] }`
 * when the project has no `lunora/agents.ts` (not an error), or
 * `{ agents: [], error }` when the file exists but could not be parsed — callers
 * decide whether that is a warning (validator) or ignorable (inference).
 */
const discoverAgentInfo = (projectRoot: string, schemaDirectory: string): DiscoverAgentInfoResult => {
    const agentsPath = join(projectRoot, schemaDirectory, AGENTS_FILENAME);

    if (!existsSync(agentsPath)) {
        return { agents: [] };
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        return { agents: discoverAgents(project, join(projectRoot, schemaDirectory)) };
    } catch (error: unknown) {
        return { agents: [], error: error instanceof Error ? error.message : String(error) };
    }
};

export type { DiscoverAgentInfoResult };
export { discoverAgentInfo };

export { type AgentIR } from "@lunora/codegen";
