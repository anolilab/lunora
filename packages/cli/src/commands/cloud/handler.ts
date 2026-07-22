import { readFileSync } from "node:fs";

import { findWranglerFile, readWranglerJsonc } from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DeployEvent, WranglerConfig } from "../../util/cloud-client";
import { deployToCloud, parseWranglerManifest, rollbackDeployment } from "../../util/cloud-client";
import type { Logger } from "../../util/logger";
import type { CloudOptions } from "./index";

type DeployKind = "dev" | "preview" | "production";

const DEPLOY_KINDS = new Set<DeployKind>(["dev", "preview", "production"]);

interface CloudCommandDeps {
    /** Deploy client (injected for tests). */
    deployFn: typeof deployToCloud;
    /** Env source for the URL + secret key (injected for tests). */
    env: Record<string, string | undefined>;
    /** Read a bundle file and return it base64-encoded (injected for tests). */
    readBundleBase64: (path: string) => string;
    /** Read the project's wrangler config (injected for tests). */
    readWrangler: (cwd: string) => undefined | WranglerConfig;
    /** Rollback client (injected for tests). */
    rollbackFn: typeof rollbackDeployment;
}

interface CloudCommandOptions {
    /** Positional args: `[subcommand, ...rest]` (rest[0] is the rollback deployment id). */
    argument: string[];
    branch?: string;
    bundlePath?: string;
    cwd: string;
    deps?: Partial<CloudCommandDeps>;
    kind?: string;
    logger: Logger;
    org?: string;
    project?: string;
    scriptName?: string;
    url?: string;
    yes?: boolean;
}

interface CloudCommandResult {
    code: number;
    /** The terminal deploy status / rollback outcome, when the call ran. */
    outcome?: string;
}

const defaultDeps = (): CloudCommandDeps => ({
    deployFn: deployToCloud,
    env: process.env,
    readBundleBase64: (path) => readFileSync(path).toString("base64"),
    readWrangler: (cwd) => {
        const wranglerPath = findWranglerFile(cwd);

        return wranglerPath ? readWranglerJsonc<WranglerConfig>(wranglerPath).parsed : undefined;
    },
    rollbackFn: rollbackDeployment,
});

/** Resolve the API URL (flag → env) and the deploy key (env only — it is a secret). */
const resolveAuth = (
    options: CloudCommandOptions,
    deps: CloudCommandDeps,
    logger: Logger,
): { apiUrl: string; deployKey: string } | null => {
    const apiUrl = options.url ?? deps.env["LUNORA_CLOUD_URL"];

    if (!apiUrl) {
        logger.error("cloud: no API URL — pass --url or set LUNORA_CLOUD_URL");

        return null;
    }

    const deployKey = deps.env["LUNORA_DEPLOY_KEY"];

    if (!deployKey) {
        logger.error("cloud: no deploy key — set LUNORA_DEPLOY_KEY (never passed as a flag)");

        return null;
    }

    return { apiUrl, deployKey };
};

const runDeploy = async (options: CloudCommandOptions, deps: CloudCommandDeps, auth: { apiUrl: string; deployKey: string }): Promise<CloudCommandResult> => {
    const { logger } = options;

    if (!options.project) {
        logger.error("cloud deploy requires a project. Usage: lunora cloud deploy --project <id> --bundle <path>");

        return { code: 1 };
    }

    if (!options.bundlePath) {
        logger.error("cloud deploy requires a bundle. Usage: lunora cloud deploy --project <id> --bundle <path-to-worker>");

        return { code: 1 };
    }

    if (options.kind !== undefined && !DEPLOY_KINDS.has(options.kind as DeployKind)) {
        logger.error(`cloud deploy: invalid --kind "${options.kind}" — expected production | preview | dev`);

        return { code: 1 };
    }

    const wrangler = deps.readWrangler(options.cwd);
    const scriptName = options.scriptName ?? (typeof wrangler?.name === "string" ? wrangler.name : undefined);

    if (!scriptName) {
        logger.error("cloud deploy: no script name — pass --name or set `name` in wrangler config");

        return { code: 1 };
    }

    const manifest = wrangler ? parseWranglerManifest(wrangler) : { bindings: {}, cronSpecs: [] };

    let bundle: string;

    try {
        bundle = deps.readBundleBase64(options.bundlePath);
    } catch (error) {
        logger.error(`cloud deploy: cannot read bundle "${options.bundlePath}": ${error instanceof Error ? error.message : String(error)}`);

        return { code: 1 };
    }

    logger.info(`cloud deploy: ${scriptName} (${options.kind ?? "production"}) → ${auth.apiUrl}`);

    const onEvent = (event: DeployEvent): void => {
        if (typeof event["phase"] === "string") {
            logger.info(`  ${event["phase"]}`);
        } else if (typeof event["event"] === "string") {
            logger.info(`  ${event["event"]}`);
        }

        if (typeof event["error"] === "string") {
            logger.error(`  ${event["error"]}`);
        }
    };

    const result = await deps.deployFn(
        {
            apiUrl: auth.apiUrl,
            bindings: manifest.bindings,
            branch: options.branch,
            bundle,
            cronSpecs: manifest.cronSpecs,
            deployKey: auth.deployKey,
            ...(options.kind ? { kind: options.kind as DeployKind } : {}),
            projectId: options.project,
            scriptName,
        },
        onEvent,
    );

    if (result.status === "live") {
        logger.success(`cloud deploy: live (${scriptName})`);

        return { code: 0, outcome: result.status };
    }

    logger.error(`cloud deploy: ended ${result.status}`);

    return { code: 1, outcome: result.status };
};

const runRollback = async (
    options: CloudCommandOptions,
    deps: CloudCommandDeps,
    auth: { apiUrl: string; deployKey: string },
): Promise<CloudCommandResult> => {
    const { logger } = options;
    const deploymentId = options.argument[1];

    if (!deploymentId) {
        logger.error("cloud rollback requires a deployment id. Usage: lunora cloud rollback <deployment-id> --org <id> --yes");

        return { code: 1 };
    }

    if (!options.org) {
        logger.error("cloud rollback requires --org <organization-id>");

        return { code: 1 };
    }

    if (!options.yes) {
        logger.error("cloud rollback shifts live traffic. Re-run with --yes to confirm.");

        return { code: 1 };
    }

    const result = await deps.rollbackFn({ apiUrl: auth.apiUrl, deployKey: auth.deployKey, deploymentId, organizationId: options.org });

    logger.success(`cloud rollback: now serving ${result.scriptName}${result.version === undefined ? "" : ` (v${String(result.version)})`}`);

    return { code: 0, outcome: result.scriptName };
};

/** `lunora cloud <deploy|rollback>` — testable body over injected client/env/fs. */
const runCloudCommand = async (options: CloudCommandOptions): Promise<CloudCommandResult> => {
    const { logger } = options;
    const deps = { ...defaultDeps(), ...options.deps };
    const subcommand = options.argument[0];

    if (subcommand !== "deploy" && subcommand !== "rollback") {
        logger.error(`cloud: unknown subcommand "${subcommand ?? ""}". Usage: lunora cloud <deploy|rollback>`);

        return { code: 1 };
    }

    const auth = resolveAuth(options, deps, logger);

    if (!auth) {
        return { code: 1 };
    }

    return subcommand === "deploy" ? runDeploy(options, deps, auth) : runRollback(options, deps, auth);
};

/** `lunora cloud` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CloudOptions> = defineHandler<CloudOptions>(({ argument, cwd, logger, options }) =>
    runCloudCommand({
        argument,
        branch: options.branch,
        bundlePath: options.bundle,
        cwd,
        kind: options.kind,
        logger,
        org: options.org,
        project: options.project,
        scriptName: options.name,
        url: options.url,
        yes: options.yes === true,
    }),
);

export { execute, runCloudCommand };
export type { CloudCommandDeps, CloudCommandOptions, CloudCommandResult };
