import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * The sibling temp path a pid-suffixed write stages through. It lives in the
 * target's directory, so the rename never crosses devices (`EXDEV`).
 */
const temporaryPathFor = (path: string): string => `${path}.tmp-${String(process.pid)}`;

/**
 * Atomically write `path`: write the content to a sibling temp file, then
 * `rename` it over the target. The rename is atomic within one filesystem, so
 * a reader can never observe a half-written file, and an interrupt mid-write
 * can't truncate the target. The temp lives in the same directory so the
 * rename never crosses devices (`EXDEV`); on any failure it is removed before
 * the error propagates, and the content is never logged or thrown.
 *
 * The temp name is random and created exclusively: a predictable name lets a
 * symlink planted there redirect the write to whatever file it points at.
 *
 * `mode: 0o600` for secret-bearing files so they are owner-only, not
 * world-readable on a shared host (Node otherwise defaults to 0o666 → 0o644
 * under the usual umask); `rename` preserves the temp file's mode. This
 * overwrites `path` by design; for a create that must not replace a peer's
 * file, use `createExclusively` in `scaffold-dev-variables`.
 */
const atomicWrite = (path: string, content: string, options: { mode?: number } = {}): void => {
    const temporaryPath = `${temporaryPathFor(path)}-${randomBytes(6).toString("hex")}`;

    try {
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", ...options });
        renameSync(temporaryPath, path);
    } catch (error) {
        // A path that already existed is someone else's, not a temp this call created.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            rmSync(temporaryPath, { force: true });
        }

        throw error;
    }
};

export { atomicWrite, temporaryPathFor };
