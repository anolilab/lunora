import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Content hash of the schema directory's TypeScript sources — everything codegen
 * reads, minus its own `_generated/` output.
 *
 * Taken before codegen runs and compared again after the project's `postcodegen`
 * has settled, this is what tells the hook's own writes apart from a developer's
 * save landing in the same window. Timing cannot: both look identical to the
 * watcher, which is why every save during a multi-second hook used to be dropped
 * outright. Content can — a formatter that rewrites a file to the same bytes
 * leaves the hash alone, and a real edit does not.
 *
 * Cheap by construction (a schema directory is a handful of files, read once per
 * regeneration, not per watcher event). An unreadable directory hashes to a
 * constant so a transient read error reads as "no change" rather than as an
 * edit — degrading toward doing nothing, never toward a spurious rerun.
 */
const fingerprintSchemaSources = (schemaDirectory: string, generatedDirectory: string): string => {
    let entries;

    try {
        entries = readdirSync(schemaDirectory, { recursive: true, withFileTypes: true });
    } catch {
        return "unreadable";
    }

    const hash = createHash("sha256");

    const paths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((path) => !(path === generatedDirectory || path.startsWith(generatedDirectory + sep)))
        .toSorted((a, b) => a.localeCompare(b));

    for (const path of paths) {
        try {
            hash.update(path).update("\u0000").update(readFileSync(path));
        } catch {
            // A file that vanished mid-walk contributes nothing; the next run sees
            // the settled tree.
        }
    }

    return hash.digest("hex");
};

export default fingerprintSchemaSources;
