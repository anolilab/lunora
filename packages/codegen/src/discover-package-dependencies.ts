import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every package name the project declares a dependency on, read from the
 * `package.json` at the project root across all four dependency fields
 * (`dependencies`, `devDependencies`, `peerDependencies`,
 * `optionalDependencies`).
 *
 * Returns `undefined` — NOT an empty set — when the manifest is absent or
 * unparseable, which is the whole reason this exists. Studio nav gating can
 * treat "declares nothing" and "cannot tell" the same way, but a check that
 * errors on a missing package cannot: conflating them makes it fire on every
 * project without a root `package.json` (the codegen fixtures, an embedded
 * schema, a tool driving `runCodegen` directly).
 */
const readPackageDependencies = (projectRoot: string): Set<string> | undefined => {
    const manifestPath = join(projectRoot, "package.json");

    if (!existsSync(manifestPath)) {
        return undefined;
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
        // A malformed manifest must never break codegen — indistinguishable from
        // an absent one for our purposes, so callers fall back the same way.
        return undefined;
    }
};

export default readPackageDependencies;
