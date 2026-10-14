import { join } from "node:path";

import { readJsonSync } from "@visulima/fs";

/** Whether `value` is a plain JSON object (not `null`, not an array). */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `package.json` at `root` as a plain object, or `undefined` when it is
 * missing, unreadable, or not a JSON object. Best-effort on purpose: every
 * caller reads one fact off it (a script, a key, the dependencies) and falls
 * back to its default rather than failing over a broken manifest.
 */
const readProjectManifest = (root: string): Readonly<Record<string, unknown>> | undefined => {
    try {
        const manifest: unknown = readJsonSync(join(root, "package.json"));

        return isRecord(manifest) ? manifest : undefined;
    } catch {
        return undefined;
    }
};

/** The string-valued entries of one dependency section; anything malformed reads as empty. */
const dependencySection = (section: unknown): Record<string, string> =>
    isRecord(section) ? Object.fromEntries(Object.entries(section).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

/**
 * The manifest's merged `devDependencies` + `dependencies` map — a runtime
 * dependency wins a name declared in both — or `{}` when it cannot be read.
 */
const readProjectDependencies = (root: string): Readonly<Record<string, string>> => {
    const manifest = readProjectManifest(root);

    return { ...dependencySection(manifest?.["devDependencies"]), ...dependencySection(manifest?.["dependencies"]) };
};

/** The names {@link readProjectDependencies} reads — empty when the manifest cannot be read. */
const readProjectDependencyNames = (root: string): ReadonlySet<string> => new Set(Object.keys(readProjectDependencies(root)));

export { readProjectDependencies, readProjectDependencyNames, readProjectManifest };
