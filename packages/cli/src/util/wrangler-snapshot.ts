/**
 * The dry-run rollback for the project's committed wrangler config.
 *
 * A dry run publishes nothing, so it must not leave a diff in a file the user
 * hand-maintains and commits — but provisioning still has to RUN, because every
 * artifact a dry run produces (the wrangler bundle, the `--emit-bindings`
 * requirements document, the validation report) has to describe the config a
 * real deploy would ship, not the one the project happened to have written down.
 *
 * So: snapshot, provision, let the artifacts read the provisioned config, then
 * put the original bytes back. The window matters more than the mechanism — the
 * caller that produces the LAST artifact is the one that owns the snapshot,
 * which is why this is a standalone helper rather than a `finally` buried in the
 * pipeline that provisions.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { findWranglerFile } from "@lunora/config/cloudflare";

/**
 * Read the project's wrangler config and return the callback that restores it.
 *
 * The callback is a no-op when the project has no wrangler config (nothing to
 * roll back) and is safe to call once at the end of a `finally`.
 */
const snapshotWranglerConfig = (projectRoot: string): (() => void) => {
    const wranglerPath = findWranglerFile(projectRoot);
    const before = wranglerPath === undefined ? undefined : readFileSync(wranglerPath, "utf8");

    return () => {
        if (wranglerPath !== undefined && before !== undefined) {
            writeFileSync(wranglerPath, before, "utf8");
        }
    };
};

export default snapshotWranglerConfig;
