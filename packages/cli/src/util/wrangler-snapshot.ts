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
 * put the original bytes back. The window matters more than the mechanism, and
 * it has exactly one owner: `runDeployCommand`, which holds it open across both
 * the bundle and `--emit-bindings`'s requirements document. A second owner is
 * how a rollback once fired between them and produced a document saying
 * `"crons": []` for an app with a nightly cron.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findWranglerFile } from "@lunora/config/cloudflare";

/**
 * Read the project's wrangler config — and `package.json`, whose `lunora.*`
 * ownership records describe that config — and return the callback that
 * restores both. Restoring the config alone would leave a record claiming
 * entries the restored config no longer has.
 *
 * The callback skips a file that was absent and is safe to call once at the
 * end of a `finally`.
 */
const snapshotWranglerConfig = (projectRoot: string): (() => void) => {
    const paths = [findWranglerFile(projectRoot), join(projectRoot, "package.json")].filter((path): path is string => path !== undefined && existsSync(path));
    const before = paths.map((path) => [path, readFileSync(path, "utf8")] as const);

    return () => {
        for (const [path, text] of before) {
            if (readFileSync(path, "utf8") !== text) {
                writeFileSync(path, text, "utf8");
            }
        }
    };
};

export default snapshotWranglerConfig;
