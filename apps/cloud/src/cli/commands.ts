import type { DeployClientOptions, DeployEvent, DeployResult } from "../deploy/client";
import { deployToCloud, rollbackDeployment } from "../deploy/client";
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
    input: {
        // Binding manifest + cron expressions from the app's wrangler.jsonc
        // (`parseWranglerManifest`), so the deploy provisions what the Worker
        // needs and the fan-out ticks the tenant's crons (§2.1 / §2.4).
        bindings?: DeployClientOptions["bindings"];
        branch?: string;
        bundle: string;
        cronSpecs?: string[];
        kind?: "dev" | "preview" | "production";
        scriptName: string;
    },
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
            ...(input.bindings ? { bindings: input.bindings } : {}),
            branch: input.branch,
            bundle: input.bundle,
            ...(input.cronSpecs && input.cronSpecs.length > 0 ? { cronSpecs: input.cronSpecs } : {}),
            deployKey: config.deployKey,
            kind: input.kind,
            projectId: config.projectId, // secret-scanner:allow -- domain field name
            scriptName: input.scriptName,
        },
        onEvent,
    );
};

/**
 * `lunora rollback` — point the linked project's stable URL back at a retained
 * release (GAPS.md A1). Requires a prior `login`; the org comes from the input
 * (the CLI resolves it from the linked project's context).
 */
export const rollback = async (
    store: ConfigStore,
    input: { deploymentId: string; organizationId: string },
    rollbackFunction: typeof rollbackDeployment = rollbackDeployment,
): Promise<{ scriptName: string; version?: number }> => {
    const config = await store.read();

    if (!config.apiUrl || !config.deployKey) {
        throw new Error("not logged in — run `lunora login` first");
    }

    return rollbackFunction({
        apiUrl: config.apiUrl,
        deploymentId: input.deploymentId,
        deployKey: config.deployKey,
        organizationId: input.organizationId,
    });
};
