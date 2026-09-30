import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ManifestConfigShape } from "@lunora/config/cloudflare";
import { buildBindingManifest, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import { dirname, relative, resolve } from "@visulima/path";

import type { DeployEvent, DeployToCloudOptions, WranglerAssets } from "../../util/cloud-client";
import { collectAssets, deployToCloud, fetchEjectPackage, resolveDeployConfigPath, rollbackDeployment } from "../../util/cloud-client";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { runEject } from "../../util/eject";
import type { Logger } from "../../util/logger";
import type { CloudOptions } from "./index";

type DeployKind = "dev" | "preview" | "production";

const DEPLOY_KINDS = new Set<DeployKind>(["dev", "preview", "production"]);

/** The parsed wrangler config a deploy reads: the binding-manifest shape plus the full `assets` section. */
type CloudWranglerConfig = Omit<ManifestConfigShape, "assets"> & { assets?: WranglerAssets };

interface CloudCommandDeps {
    /** Deploy client (injected for tests). */
    deployFn: typeof deployToCloud;
    /** Eject client (injected for tests). */
    ejectFn: typeof fetchEjectPackage;
    /** Env source for the URL + secret key (injected for tests). */
    env: Record<string, string | undefined>;
    /** Read a bundle file and return it base64-encoded (injected for tests). */
    readBundleBase64: (path: string) => string;
    /** Read the project's wrangler config and where it lives (injected for tests). */
    readWrangler: (cwd: string) => { config: CloudWranglerConfig; path: string } | undefined;
    /** Rollback client (injected for tests). */
    rollbackFn: typeof rollbackDeployment;
    /** Write one eject output file under `<cwd>/<dir>` (injected for tests). */
    writeEjectFile: (directory: string, name: string, content: string) => Promise<void>;
}

interface CloudCommandOptions {
    /** Positional args: `[subcommand, ...rest]` (rest[0] is the rollback deployment id). */
    argument: string[];
    branch?: string;
    bundlePath?: string;
    cwd: string;
    deps?: Partial<CloudCommandDeps>;
    /** Output directory for `eject`, relative to `cwd` (defaults to `eject`). */
    ejectOut?: string;
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

const defaultDeps = (): CloudCommandDeps => {
    return {
        deployFn: deployToCloud,
        env: process.env,
        readBundleBase64: (path) => readFileSync(path).toString("base64"),
        readWrangler: (cwd) => {
            // The built config first (a Vite build's resolved, assets-bearing config), then the source one.
            const path = resolveDeployConfigPath(cwd) ?? findWranglerFile(cwd);
            const config = path === undefined ? undefined : readWranglerJsonc<CloudWranglerConfig>(path).parsed;

            return path === undefined || config === undefined ? undefined : { config, path };
        },
        ejectFn: fetchEjectPackage,
        rollbackFn: rollbackDeployment,
        writeEjectFile: (directory, name, content) => {
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, name), content);

            return Promise.resolve();
        },
    };
};

/** Resolve the API URL (flag → env) and the deploy key (env only — it is a secret). */
const resolveAuth = (options: CloudCommandOptions, deps: CloudCommandDeps, logger: Logger): { apiUrl: string; deployKey: string } | undefined => {
    const apiUrl = options.url ?? deps.env["LUNORA_CLOUD_URL"];

    if (!apiUrl) {
        logger.error("cloud: no API URL — pass --url or set LUNORA_CLOUD_URL");

        return undefined;
    }

    const deployKey = deps.env["LUNORA_DEPLOY_KEY"];

    if (!deployKey) {
        logger.error("cloud: no deploy key — set LUNORA_DEPLOY_KEY (never passed as a flag)");

        return undefined;
    }

    return { apiUrl, deployKey };
};

/**
 * What the deploy request says about the Worker, derived from its wrangler
 * config: the binding manifest, the crons, and the static assets. Logs and
 * returns `undefined` when the assets cannot be collected.
 */
const deployPayload = (
    wrangler: { config: CloudWranglerConfig; path: string },
    logger: Logger,
): Pick<DeployToCloudOptions, "assets" | "cronSpecs" | "manifest"> | undefined => {
    const bindingManifest = buildBindingManifest(wrangler.config);

    // Not fatal: what the manifest does model still deploys, and the server refuses
    // any of it it cannot support. These sections are simply not described.
    if (bindingManifest.unknown.length > 0) {
        logger.warn(
            `cloud deploy: the binding manifest does not model these wrangler sections: ${bindingManifest.unknown.join(", ")}. Anything they bind will be missing from the deployment.`,
        );
    }

    const payload: Pick<DeployToCloudOptions, "assets" | "cronSpecs" | "manifest"> = {
        cronSpecs: [...bindingManifest.crons],
        manifest: {
            bindings: [...bindingManifest.bindings],
            ...(bindingManifest.compatibilityDate === undefined ? {} : { compatibilityDate: bindingManifest.compatibilityDate }),
            ...(bindingManifest.compatibilityFlags === undefined ? {} : { compatibilityFlags: [...bindingManifest.compatibilityFlags] }),
        },
    };

    if (!wrangler.config.assets) {
        return payload;
    }

    const { directory } = wrangler.config.assets;

    if (!directory) {
        logger.error("cloud deploy: wrangler `assets` has no `directory` — set it to your build output");

        return undefined;
    }

    try {
        return { ...payload, assets: collectAssets(resolve(dirname(wrangler.path), directory), wrangler.config.assets) };
    } catch (error) {
        logger.error(`cloud deploy: ${error instanceof Error ? error.message : String(error)}`);

        return undefined;
    }
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

    // The binding manifest IS the deploy's statement of what the Worker needs;
    // without a config there is nothing to derive it from, and an empty one would
    // deploy a Worker whose every `env.X` is undefined.
    if (!wrangler) {
        logger.error(`cloud deploy: no readable wrangler config in ${options.cwd} — the binding manifest is derived from it`);

        return { code: 1 };
    }

    const scriptName = options.scriptName ?? wrangler.config.name;

    if (!scriptName) {
        logger.error("cloud deploy: no script name — pass --name or set `name` in wrangler config");

        return { code: 1 };
    }

    const payload = deployPayload(wrangler, logger);

    if (!payload) {
        return { code: 1 };
    }

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
            ...payload,
            apiUrl: auth.apiUrl,
            branch: options.branch,
            bundle,
            deployKey: auth.deployKey,
            ...(options.kind ? { kind: options.kind as DeployKind } : {}),
            projectId: options.project, // gitleaks:allow -- the --project flag's value, not a Cypress project id
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

const runRollback = async (options: CloudCommandOptions, deps: CloudCommandDeps, auth: { apiUrl: string; deployKey: string }): Promise<CloudCommandResult> => {
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

/**
 * `lunora cloud eject <deployment-id>` — the no-lock-in exit hatch (GAPS.md D2).
 *
 * Writes `export.ndjson`, a BYO `wrangler.jsonc` and an Alchemy 2 program (both
 * derived from the project's own wrangler config) and a restore README into
 * `./eject` (or `--out`). Read-only against the platform: the managed deployment
 * keeps serving afterwards, which is the point — ejecting is something you should
 * be able to do at any time, including just to check that you can.
 */
const runEjectCommand = async (
    options: CloudCommandOptions,
    deps: CloudCommandDeps,
    auth: { apiUrl: string; deployKey: string },
): Promise<CloudCommandResult> => {
    const { logger } = options;
    const deploymentId = options.argument[1];

    if (!deploymentId) {
        logger.error("cloud eject requires a deployment id. Usage: lunora cloud eject <deployment-id> [--out <dir>]");

        return { code: 1 };
    }

    // Before the network call: without the project's config there is nothing
    // to derive the ejected config from, and a template would silently drop
    // every binding it does not know about.
    const wrangler = deps.readWrangler(options.cwd);

    if (!wrangler) {
        logger.error(
            `cloud eject: no readable wrangler config in ${options.cwd} — run eject from the project directory; the ejected config is derived from it`,
        );

        return { code: 1 };
    }

    const ejectOut = options.ejectOut ?? "eject";
    const outputDirectory = join(options.cwd, ejectOut);

    let result;

    try {
        result = await runEject({
            fetchPackage: () => deps.ejectFn({ apiUrl: auth.apiUrl, deployKey: auth.deployKey, deploymentId }),
            outputDirectory: ejectOut,
            project: { config: wrangler.config, configDirectory: relative(outputDirectory, dirname(wrangler.path)) },
            writeFile: (name, content) => deps.writeEjectFile(outputDirectory, name, content),
        });
    } catch (error) {
        logger.error(`cloud eject: ${error instanceof Error ? error.message : String(error)}`);

        return { code: 1 };
    }

    for (const file of result.files) {
        logger.info(`  ${join(outputDirectory, file)}`);
    }

    if (result.unsupported.length > 0) {
        logger.warn(`cloud eject: alchemy.run.ts does not carry: ${result.unsupported.join(", ")} (listed in the README)`);
    }

    logger.success(`cloud eject: wrote ${String(result.files.length)} files — your deployment keeps serving.`);

    return { code: 0, outcome: outputDirectory };
};

/** `lunora cloud <deploy|eject|rollback>` — testable body over injected client/env/fs. */
const runCloudCommand = async (options: CloudCommandOptions): Promise<CloudCommandResult> => {
    const { logger } = options;
    const deps = { ...defaultDeps(), ...options.deps };
    const subcommand = options.argument[0];

    if (subcommand !== "deploy" && subcommand !== "eject" && subcommand !== "rollback") {
        logger.error(`cloud: unknown subcommand "${subcommand ?? ""}". Usage: lunora cloud <deploy|eject|rollback>`);

        return { code: 1 };
    }

    const auth = resolveAuth(options, deps, logger);

    if (!auth) {
        return { code: 1 };
    }

    if (subcommand === "deploy") {
        return runDeploy(options, deps, auth);
    }

    return subcommand === "eject" ? runEjectCommand(options, deps, auth) : runRollback(options, deps, auth);
};

/** `lunora cloud` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CloudOptions> = defineHandler<CloudOptions>(({ argument, cwd, logger, options }) =>
    runCloudCommand({
        argument,
        branch: options.branch,
        bundlePath: options.bundle,
        cwd,
        ejectOut: options.out,
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
