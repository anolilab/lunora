/**
 * Where Studio's generated documents (the OpenAPI and OpenRPC specs and the
 * architecture manifest) live in a Worker that wrangler bundles.
 *
 * Only the admin routes read them, and they grow with the app (hundreds of KiB in
 * a large one), so they ship as Workers Static Assets rather than in the Worker
 * script. A file in the assets directory is public unless the Worker runs first
 * for its path, so the documents go into a directory and an `assets` block Lunora
 * owns, with `run_worker_first: true`: every request still reaches the Worker
 * first, exactly as with no `assets` block, and the files are reachable only
 * through the binding. The Worker's reserved-path guard answers a direct request
 * for `/_lunora/studio/*` with a 404, and the asset router answers an encoded
 * spelling of it with a redirect to that path.
 *
 * Everywhere else the documents stay modules the admin routes `import()`: a Vite
 * or Rsbuild build, which already splits them into their own chunks and builds the
 * assets directory from the client build, not from `wrangler.jsonc`; a project
 * with its own `assets` block, whose directory is the app's static output, rebuilt
 * by its client build; and the Node and celld targets, which have no Workers
 * Static Assets.
 *
 * Reconcile (which writes the block) and codegen (which writes the files and the
 * loaders) both decide through {@link studioAssetsPlan}, so they cannot disagree.
 */
import { detectFramework } from "../detect-framework";
import { readProjectDependencyNames, readProjectManifest } from "../project-manifest";
import { isPlainObject } from "./guards";

/** The directory of the Lunora-owned `assets` block, relative to `wrangler.jsonc`. `.lunora/` is Lunora's gitignored state directory. */
const STUDIO_ASSETS_DIRECTORY = ".lunora/studio-assets";

/** The binding of the Lunora-owned `assets` block. */
const STUDIO_ASSETS_BINDING = "ASSETS";

/** The `main` the Vite plugin generates; such a Worker is built by Vite whatever else the project configures. */
const COMPOSED_MAIN = "virtual:lunora/worker";

/** Packages that run the Worker build themselves (and so build the assets directory from a client build). */
const WORKER_BUILDING_PLUGINS: ReadonlyArray<string> = ["@lunora/vite", "@lunora/rspack", "@cloudflare/vite-plugin"];

interface StudioAssetsPlan {
    /** The `assets.binding` the Worker reads the documents through. */
    binding: string;
    /** The `assets.directory` the documents are written under, relative to `wrangler.jsonc`. */
    directory: string;
}

/** The slice of `wrangler.jsonc` read here; parsed from untrusted JSONC, so any level may be the wrong type. */
interface StudioAssetsShape {
    assets?: unknown;
    env?: unknown;
    main?: unknown;
}

/** The block reconcile writes. */
const ownedStudioAssetsBlock = (): { binding: string; directory: string; run_worker_first: true } => {
    return { binding: STUDIO_ASSETS_BINDING, directory: STUDIO_ASSETS_DIRECTORY, run_worker_first: true };
};

/** Whether `assets` is exactly the block reconcile writes. Its directory, under `.lunora/`, is what marks it as Lunora's. */
const isOwnedStudioAssets = (assets: unknown): boolean =>
    isPlainObject(assets) &&
    Object.keys(assets).length === 3 &&
    assets["binding"] === STUDIO_ASSETS_BINDING &&
    assets["directory"] === STUDIO_ASSETS_DIRECTORY &&
    assets["run_worker_first"] === true;

/**
 * Whether wrangler bundles the Worker from its sources, rather than a bundler plugin or a framework build. A root
 * without a readable `package.json` is not a project this can tell, so it keeps the bundle.
 */
const bundledByWrangler = (projectRoot: string, parsed: StudioAssetsShape): boolean => {
    if (readProjectManifest(projectRoot) === undefined || parsed.main === COMPOSED_MAIN || detectFramework(projectRoot).class !== "C") {
        return false;
    }

    const dependencies = readProjectDependencyNames(projectRoot);

    return !WORKER_BUILDING_PLUGINS.some((name) => dependencies.has(name));
};

/**
 * Where the Studio documents go as assets, or `undefined` to keep them in the
 * Worker bundle. Assets only for a Cloudflare Worker wrangler bundles, with no
 * `assets` block of its own anywhere (an `env.<name>` block replaces the
 * top-level one whole), or only the one Lunora wrote.
 */
const studioAssetsPlan = (projectRoot: string, parsed: StudioAssetsShape | undefined, target?: string): StudioAssetsPlan | undefined => {
    if (parsed === undefined || (target !== undefined && target !== "cloudflare")) {
        return undefined;
    }

    const environments = isPlainObject(parsed.env) ? Object.values(parsed.env) : [];
    const ownAssets =
        (parsed.assets !== undefined && !isOwnedStudioAssets(parsed.assets)) ||
        environments.some((block) => isPlainObject(block) && block["assets"] !== undefined);

    if (ownAssets || !bundledByWrangler(projectRoot, parsed)) {
        return undefined;
    }

    return { binding: STUDIO_ASSETS_BINDING, directory: STUDIO_ASSETS_DIRECTORY };
};

export type { StudioAssetsPlan };
export { isOwnedStudioAssets, ownedStudioAssetsBlock, STUDIO_ASSETS_DIRECTORY, studioAssetsPlan };
