import { fileURLToPath } from "node:url";

import { readProjectManifest } from "@lunora/config";
import { findUpSync } from "@visulima/fs";
import { dirname } from "@visulima/path";

/**
 * The running `@lunora/cli`'s package root: the nearest directory above
 * `startDirectory` (this module by default) whose `package.json` is named
 * `@lunora/cli`. Walked rather than fixed because packem hoists built modules
 * into a hashed `dist/packem_shared/` chunk of varying depth, and named because
 * in a nested install the first `package.json` met is some dependency's.
 */
const findCliPackageRoot = (startDirectory: string = dirname(fileURLToPath(import.meta.url))): string | undefined => {
    const manifestPath = findUpSync((directory) => (readProjectManifest(directory)?.["name"] === "@lunora/cli" ? "package.json" : undefined), {
        cwd: startDirectory,
    });

    return manifestPath === undefined ? undefined : dirname(manifestPath);
};

let cliVersion: string | undefined;

/**
 * The running `@lunora/cli`'s version, or `"0.0.0"` (the unpublished sentinel,
 * which also keeps the update notifier quiet) when it can't be determined.
 * Resolved once per process.
 */
const resolveCliVersion = (): string => {
    if (cliVersion === undefined) {
        const root = findCliPackageRoot();
        const version = root === undefined ? undefined : readProjectManifest(root)?.["version"];

        cliVersion = typeof version === "string" && version !== "" ? version : "0.0.0";
    }

    return cliVersion;
};

export { findCliPackageRoot, resolveCliVersion };
