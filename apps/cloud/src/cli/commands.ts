import type { DeployEvent, DeployResult } from "../deploy/client";
import { deployToCloud } from "../deploy/client";
import type { CliConfig, ConfigStore } from "./config";

/**
 * `lunora` cloud CLI commands (CLOUD-PLAN.md §2.2). Pure logic over a
 * {@link ConfigStore} + the deploy client; the cerebro/CLI wiring in
 * `@lunora/cli` calls these.
 */

/** `lunora login` — persist the API endpoint + deploy key. */
export const login = async (store: ConfigStore, input: { apiUrl: string; deployKey: string }): Promise<void> => {
    const config = await store.read();

    await store.write({ ...config, apiUrl: input.apiUrl, deployKey: input.deployKey });
};

type LinkInput = { projectId: string }; // secret-scanner:allow -- domain field name

/** `lunora link` — bind the working directory to a project. */
export const link = async (store: ConfigStore, input: LinkInput): Promise<void> => {
    const config = await store.read();

    await store.write({ ...config, projectId: input.projectId });
};

/** Current login/link state. */
export const status = (config: CliConfig): { linked: boolean; loggedIn: boolean } => {
    return {
        linked: Boolean(config.projectId),
        loggedIn: Boolean(config.apiUrl && config.deployKey),
    };
};

/**
 * `lunora deploy` — push to the managed cloud and stream progress. Requires a
 * prior `login` + `link`. `deployFn` is injected for testing.
 */
export const deploy = async (
    store: ConfigStore,
    input: { branch?: string; kind?: "dev" | "preview" | "production"; scriptName: string },
    onEvent: (event: DeployEvent) => void,
    deployFunction: typeof deployToCloud = deployToCloud,
): Promise<DeployResult> => {
    const config = await store.read();

    if (!config.apiUrl || !config.deployKey) {
        throw new Error("not logged in — run `lunora login` first");
    }

    if (!config.projectId) {
        throw new Error("no linked project — run `lunora link` first");
    }

    return deployFunction(
        {
            apiUrl: config.apiUrl,
            branch: input.branch,
            deployKey: config.deployKey,
            kind: input.kind,
            projectId: config.projectId, // secret-scanner:allow -- domain field name
            scriptName: input.scriptName,
        },
        onEvent,
    );
};
