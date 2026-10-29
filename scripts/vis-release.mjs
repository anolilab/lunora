/**
 * Versions and publishes the pending change files in ONE vis context, without
 * committing or pushing the branch.
 *
 * `vis release ci release --auto-publish` commits the bumps first and tags that
 * commit, then pushes the branch once with no retry. If the branch moved during
 * the ~15-minute run the push fails, the tags sit on a commit that never lands,
 * and every later run recomputes the same versions and dies on the tag collision.
 * Here nothing is committed, so vis tags the commit the job checked out (already
 * on the branch) and the workflow pushes the bumps as one commit, with retries.
 *
 * The standalone `version` / `publish` commands cannot be chained instead:
 * `version` consumes the change files, and `publish` then finds nothing to do.
 */
import { release } from "@visulima/vis/release";

const { publish, version } = await release({ skipPublish: process.argv.includes("--skip-publish") });

for (const { name, newVersion, oldVersion } of version.plan.releases) {
    console.log(`${name}: ${oldVersion} → ${newVersion}`);
}

for (const { name, reason } of [...publish.skipped, ...publish.failed]) {
    console.log(`${name}: ${reason}`);
}

console.log(`Versioned ${version.plan.releases.length}, published ${publish.published.length}, failed ${publish.failed.length}.`);

process.exitCode = publish.failed.length > 0 ? 1 : 0;
