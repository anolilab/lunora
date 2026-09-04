/**
 * The Cloudflare {@link DeployDriver} — the default target, and the only one
 * with a toolchain.
 *
 * Deliberately thin: it describes the `wrangler` argv for each command and
 * nothing else. Reconciling `wrangler.jsonc` is not here — the CLI's `deploy` /
 * `dev` handlers call `reconcileWrangler*` directly, because writing real host
 * configuration needs the Cloudflare encodings (binding names, DO class wiring,
 * migration tags) that a provider-neutral seam has no way to carry.
 */

import type { DeployDriver, DriverToolchain } from "../deploy-driver";

/**
 * Cloudflare's `wrangler` command surface.
 *
 * Each builder reproduces exactly the argv the CLI assembled inline before the
 * driver existed — including flag order, which keeps the change invisible to
 * the handlers' spawn assertions. `tool` is the bare binary: the CLI wraps it
 * for the project's package manager.
 */
const CLOUDFLARE_TOOLCHAIN: DriverToolchain = {
    deploy: (request) => {
        // `versions upload` publishes a new Version with a preview URL instead
        // of taking production traffic.
        const args: string[] = request.preview === true ? ["versions", "upload"] : ["deploy"];

        // Framework composition deploys a wrapper entry that overrides the
        // adapter-owned `main` in wrangler.jsonc.
        if (request.entry !== undefined) {
            args.push(request.entry);
        }

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        if (request.dryRun === true) {
            args.push("--dry-run");
        }

        // `--metafile` rides with `--outdir`: the esbuild metafile is what makes
        // the emitted bundle inspectable for CI artifacting.
        if (request.outDir !== undefined) {
            args.push("--outdir", request.outDir, "--metafile");
        }

        return { args, tool: "wrangler" };
    },

    dev: (request) => {
        const args: string[] = ["dev"];

        if (request.configPath !== undefined) {
            args.push("--config", request.configPath);
        }

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        args.push(...(request.extraArgs ?? []));

        return { args, tool: "wrangler" };
    },

    secretList: (request) => {
        const args: string[] = ["secret", "list", "--format", "json"];

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        return { args, tool: "wrangler" };
    },

    secretPut: (request) => {
        // The value is fed on stdin by the caller, never argv — so it stays out
        // of the process table and shell history.
        const args: string[] = ["secret", "put", request.key ?? ""];

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        return { args, tool: "wrangler" };
    },

    tail: (request) => {
        const args: string[] = ["tail"];

        if (request.worker !== undefined) {
            args.push(request.worker);
        }

        if (request.environment !== undefined) {
            args.push("--env", request.environment);
        }

        if (request.format !== undefined) {
            args.push("--format", request.format);
        }

        if (request.status !== undefined) {
            args.push("--status", request.status);
        }

        if (request.search !== undefined) {
            args.push("--search", request.search);
        }

        if (request.temporary === true) {
            args.push("--temporary");
        }

        return { args, tool: "wrangler" };
    },
};

/** The Cloudflare deploy driver. */
const CLOUDFLARE_DRIVER: DeployDriver = {
    id: "cloudflare",
    name: "Cloudflare",
    toolchain: CLOUDFLARE_TOOLCHAIN,
};

export default CLOUDFLARE_DRIVER;
