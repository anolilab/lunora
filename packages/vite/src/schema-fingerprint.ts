import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listLunoraSourceFiles } from "@lunora/codegen";

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
 * The file set comes from codegen's own `listLunoraSourceFiles` (plus
 * `schema.ts`, which discovery loads separately), so "what codegen reads" is one
 * decision rather than two that drift: a `readdirSync` walk of its own silently
 * disagreed about symlinked sources, which is exactly the case where a
 * regeneration must not be judged a no-op.
 *
 * Cheap by construction (a schema directory is a handful of files, read once per
 * regeneration, not per watcher event). An unreadable directory hashes to a
 * constant so a transient read error reads as "no change" rather than as an
 * edit — degrading toward doing nothing, never toward a spurious rerun.
 */
const fingerprintSchemaSources = (schemaDirectory: string): string => {
    if (!existsSync(schemaDirectory)) {
        return "unreadable";
    }

    const paths = listLunoraSourceFiles(schemaDirectory);
    const schemaPath = join(schemaDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        paths.push(schemaPath);
    }

    const hash = createHash("sha256");

    for (const path of paths.toSorted((a, b) => a.localeCompare(b))) {
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
