import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The set of every package name the project declares a dependency on, read from
 * the `package.json` at the project root across all four dependency fields
 * (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`).
 *
 * Studio nav gating OR's this into the per-feature visibility: a package wired
 * only in the worker entry (`src/server`) — not under `lunora/` — is invisible to
 * the `lunora/`-scoped usage scan, but its presence here keeps the feature's page
 * shown. Reading declared deps (rather than walking the worker entry) keeps the
 * signal cheap and robust to however the app composes its worker.
 *
 * Returns an empty set when the manifest is absent or unparseable — gating then
 * falls back to the usage/schema signals alone, never throwing codegen.
 */
const discoverPackageDependencies = (projectRoot: string): Set<string> => {
    const manifestPath = join(projectRoot, "package.json");

    if (!existsSync(manifestPath)) {
        return new Set();
    }

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const names = new Set<string>();

        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            const section = manifest[field];

            if (section !== null && typeof section === "object") {
                for (const name of Object.keys(section)) {
                    names.add(name);
                }
            }
        }

        return names;
    } catch {
        // A malformed manifest must never break codegen — treat it as "no
        // declared deps" so gating leans on the usage/schema signals instead.
        return new Set();
    }
};

export default discoverPackageDependencies;
