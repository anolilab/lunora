/**
 * Atomic source-file writer shared by the studio-host handlers (schema edit,
 * policy scaffold).
 *
 * Writes `text` to a sibling `.lunora-tmp` file, then `rename`s it over the
 * target. The rename is atomic within a filesystem, so a crash mid-write can
 * never leave a half-written file at `path`. On any failure the temp file is
 * removed before the error propagates, so a crashed rename doesn't leave a stray
 * `<path>.lunora-tmp` behind.
 *
 * The `.dev.vars` writers in `scaffold-dev-variables` use their own exclusive-
 * create / `0o600` / compare-and-swap variants for their concurrency and secret-
 * permission needs, so they intentionally don't route through here.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** Write source atomically (temp file + rename), cleaning up the temp file on failure. */
const writeFileAtomic = (path: string, text: string): void => {
    const temporaryPath = `${path}.lunora-tmp`;

    try {
        writeFileSync(temporaryPath, text, "utf8");
        renameSync(temporaryPath, path);
    } catch (error) {
        rmSync(temporaryPath, { force: true });

        throw error;
    }
};

export default writeFileAtomic;
