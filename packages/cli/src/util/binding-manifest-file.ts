/**
 * The declarative description of what this Worker needs, for whoever is going to
 * provide it.
 *
 * Three entry points, one derivation. `lunora bindings` answers the question
 * without running anything, for a supervisor planning its graph before it starts
 * a single process. `lunora build --emit-bindings` hands a deployer — Terraform,
 * Pulumi, Alchemy — the requirements it must provision. `lunora dev` writes the
 * same document plus where the running server is, so a task runner can proxy to
 * it and reserve its port instead of restating both in a config that drifts.
 *
 * One derivation on purpose: the requirements a deployer provisions cannot
 * disagree with the ones a dev graph proxies, and a supervisor that has learned
 * to read one of these has learned to read all of them.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import type { BindingManifest, ManifestConfigShape } from "@lunora/config/cloudflare";
import { buildBindingManifest, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import { dirname, isAbsolute, resolve } from "@visulima/path";

import type { Logger } from "./logger";

/** Where a running dev server can be reached, added by `lunora dev`. */
interface DevManifestSection {
    /**
     * The origin the worker serves on — what a sibling worker or proxy points at.
     *
     * Absent on the Vite flavors, where the CLI does not own the port: Vite
     * resolves its own, possibly after this file is written, so the value the
     * plan carries there is a pre-listen guess. Publishing the guess would point
     * a supervisor's proxy at a port nothing is listening on, which is worse than
     * making it read {@link DevManifestSection.statusFile} — the record Vite
     * writes with its real URL once it is up.
     */
    origin?: string;

    /**
     * The file carrying live status, including the `readyAt` stamp.
     *
     * Named rather than inlined because this manifest is written once at startup
     * and readiness is not yet true then. Pointing at the record keeps the
     * document honest instead of shipping a `ready: false` that never updates.
     */
    statusFile: string;
}

/** The emitted document: the deploy-time requirements, plus dev-time reachability when `lunora dev` wrote it. */
interface EmittedBindingManifest extends BindingManifest {
    dev?: DevManifestSection;
}

/**
 * Derive the manifest from the project's wrangler config.
 *
 * No readable `wrangler.jsonc` is an ERROR rather than an empty manifest: an
 * empty requirements document reads as "this Worker needs nothing", which a
 * deployer acts on by provisioning nothing. Callers decide whether that is fatal
 * — it is when someone asked for the file, and it is not when we are writing one
 * unasked.
 */
const deriveBindingManifest = (projectRoot: string): { error?: string; manifest?: BindingManifest } => {
    const wranglerPath = findWranglerFile(projectRoot);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<ManifestConfigShape>(wranglerPath).parsed;

    if (parsed === undefined) {
        return {
            error: `no readable wrangler config in ${projectRoot}. The binding manifest is derived from it, and an empty one would tell a deployer this Worker needs nothing.`,
        };
    }

    return { manifest: buildBindingManifest(parsed) };
};

/**
 * Derive the manifest and write it to `destination` (relative paths resolve
 * against `projectRoot`).
 */
const writeBindingManifestFile = (options: {
    destination: string;
    /** Dev-time reachability, when `lunora dev` is the writer. */
    dev?: DevManifestSection;
    logger: Logger;
    projectRoot: string;
}): { error?: string } => {
    const { destination, dev, logger, projectRoot } = options;
    const derived = deriveBindingManifest(projectRoot);

    if (derived.manifest === undefined) {
        return { error: derived.error };
    }

    const manifest: EmittedBindingManifest = { ...derived.manifest, ...(dev === undefined ? {} : { dev }) };
    const target = isAbsolute(destination) ? destination : resolve(projectRoot, destination);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");

    logger.success(`binding manifest written to ${target} (${manifest.bindings.length.toString()} bindings, ${manifest.crons.length.toString()} crons)`);

    // Not an error: the manifest is still usable. But a consumer acting on it
    // would silently under-provision, so say which section was not carried
    // rather than leaving them to find out at runtime.
    if (manifest.unknown.length > 0) {
        logger.warn(
            `binding manifest does not model these wrangler sections: ${manifest.unknown.join(", ")}. ` +
                `Anything they bind must be provisioned by hand — please report them so the manifest can cover them.`,
        );
    }

    return {};
};

export type { DevManifestSection, EmittedBindingManifest };
export { deriveBindingManifest, writeBindingManifestFile };
