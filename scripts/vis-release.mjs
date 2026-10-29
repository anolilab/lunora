// Versions and publishes without committing, so the tags land on the checked-out (already pushed)
// commit: `vis release ci release` tags its own commit and pushes once, stranding the tags when the
// branch moved. `version` + `publish` can't chain: `version` consumes the change files.
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
