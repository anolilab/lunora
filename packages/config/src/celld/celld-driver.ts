/**
 * celld deploy driver.
 *
 * celld (github.com/denoland/celld) is a self-hosted fleet of Workers +
 * Durable Objects nodes that executes Wrangler bundles, so a Lunora app runs on
 * it unchanged; what differs is the CLI that ships it. `celld deploy` bundles
 * the Worker with esbuild and writes the deployment to the fleet bucket, which
 * it reads from `CELLD_BUCKET` (plus the standard AWS / GCS / Azure credential
 * environment) — so the driver passes no bucket and never sees a credential.
 * `celld dev` runs a single node against a local object store under `.celld/`.
 *
 * Both commands take the celld projection of the project's wrangler config
 * (`celld-config.ts`), because celld refuses keys Lunora's Cloudflare
 * reconcilers write.
 *
 * `celld` is a standalone binary (`curl -fsSL https://celld.dev/install.sh | sh`),
 * not an npm package, hence `onPath`. There is no secret or tail command:
 * celld carries configuration in plain `vars` (and `.dev.vars` under
 * `celld dev`), and has no log stream a CLI can follow.
 */
import type { DeployDriver, DeployRequest, DriverToolchain } from "../deploy-driver";
import { writeCelldConfig } from "./celld-config";

/**
 * The deploy options celld has no equivalent for, with what to do instead.
 * Refused rather than ignored: `--env` quietly deploying the top-level
 * config, or `--preview` quietly replacing production, is worse than not
 * running.
 */
const UNSUPPORTED_DEPLOY_OPTIONS: ReadonlyArray<[keyof DeployRequest, string]> = [
    ["entry", "`celld deploy` deploys the config's `main`; a composed framework entry has no celld equivalent yet"],
    ["environment", "celld has no Wrangler environments — deploy a separate config per environment"],
    ["outDir", "`celld deploy` does not write its bundle to disk"],
    ["preview", "celld has no preview versions — a deploy replaces the fleet's current deployment"],
    ["temporary", "celld has no short-lived accounts — it deploys to the fleet bucket in CELLD_BUCKET"],
];

const CELLD_TOOLCHAIN: DriverToolchain = {
    deploy: (request) => {
        const refused = UNSUPPORTED_DEPLOY_OPTIONS.find(([option]) => request[option] !== undefined && request[option] !== false);

        if (refused !== undefined) {
            throw new Error(refused[1]);
        }

        // `celld deploy --dry-run` bundles and prints the version without
        // writing to the bucket.
        return { args: ["deploy", request.configPath ?? ".", ...(request.dryRun === true ? ["--dry-run"] : [])], onPath: true, tool: "celld" };
    },

    dev: (request) => {
        if (request.environment !== undefined) {
            throw new Error("celld has no Wrangler environments — `celld dev` runs the top-level config");
        }

        return { args: ["dev", request.configPath ?? ".", ...(request.extraArgs ?? [])], onPath: true, tool: "celld" };
    },
};

const CELLD_DRIVER: DeployDriver = {
    id: "celld",
    name: "celld",
    projectConfig: writeCelldConfig,
    toolchain: CELLD_TOOLCHAIN,
};

export default CELLD_DRIVER;
