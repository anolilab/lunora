/**
 * Publish a minimal placeholder version of a package so its npm name exists.
 *
 * Why: npm **trusted publishing** (`npm trust github …`) can only be configured
 * for a package that already exists on the registry. A brand-new `@lunora/*`
 * name 404s, so we publish a tiny `0.0.0` placeholder once to claim it — then
 * `npm trust github <name> --file semantic-release.yml --repo anolilab/lunora
 * --env release` and let CI ship the real `1.0.0-alpha.x` with provenance.
 *
 * The placeholder ships **no source** — only a `package.json` + README written
 * to a temp dir — so it can never be mistaken for a usable release.
 *
 * It publishes under the `placeholder` dist-tag (NOT `latest`): real releases
 * are prereleases on the `alpha` tag, so we must not leave `latest` pointing at
 * the empty `0.0.0` and break the default `npm install`.
 *
 * Manual placeholder publishes run WITHOUT provenance on purpose (provenance
 * needs the CI OIDC environment; a local `npm publish --provenance` would fail).
 *
 * Usage (after `npm login` with publish rights on the @lunora scope) — targets
 * are required, by npm name or bare dir, so a stale default can't re-publish an
 * already-claimed name:
 *   node scripts/publish-name-placeholder.mjs @lunora/bindings @lunora/queue
 *   node scripts/publish-name-placeholder.mjs bindings            # bare dir form
 *   DRY_RUN=1 node scripts/publish-name-placeholder.mjs bindings  # print, don't publish
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_VERSION = "0.0.0";
/** Dist-tag for the placeholder — never `latest`, which must stay free for the first stable release. */
const PLACEHOLDER_TAG = "placeholder";

/** Resolve a CLI arg (npm name or bare dir) to its packages/<dir>. */
const toDirName = (arg) => arg.replace(/^@lunora\//u, "");

const args = process.argv.slice(2);
const dryRun = process.env.DRY_RUN === "1";

if (args.length === 0) {
    console.error("Usage: node scripts/publish-name-placeholder.mjs <package…>   (e.g. @lunora/bindings @lunora/queue)");
    process.exit(1);
}

const failures = [];

for (const dir of args.map(toDirName)) {
    const realPath = join(ROOT, "packages", dir, "package.json");

    let real;

    try {
        real = JSON.parse(readFileSync(realPath, "utf8"));
    } catch (error) {
        console.error(`✗ ${dir}: cannot read ${realPath} — ${error.message}`);
        failures.push(dir);

        continue;
    }

    if (real.private) {
        console.log(`⏭  ${real.name} is private — skipping (it is never published).`);

        continue;
    }

    const placeholder = {
        name: real.name,
        version: PLACEHOLDER_VERSION,
        description: "Placeholder to reserve the npm name. Real releases are published from CI — install the latest version.",
        license: real.license,
        author: real.author,
        homepage: real.homepage,
        repository: real.repository,
        publishConfig: { access: "public" },
    };

    const stage = mkdtempSync(join(tmpdir(), `lunora-placeholder-${dir}-`));

    try {
        writeFileSync(join(stage, "package.json"), `${JSON.stringify(placeholder, null, 2)}\n`);
        writeFileSync(
            join(stage, "README.md"),
            `# ${real.name}\n\nThis \`${PLACEHOLDER_VERSION}\` (\`${PLACEHOLDER_TAG}\` tag) is a name-reservation placeholder. Install the latest published version for real code.\n`,
        );

        console.log(`\n📦 ${real.name}@${PLACEHOLDER_VERSION} (placeholder, --tag ${PLACEHOLDER_TAG}, no provenance) from ${stage}`);

        if (dryRun) {
            console.log("   DRY_RUN=1 — not publishing. package.json:");
            console.log(JSON.stringify(placeholder, null, 2));
        } else {
            try {
                execFileSync("npm", ["publish", "--tag", PLACEHOLDER_TAG], { cwd: stage, stdio: "inherit" });
                console.log(`   ✓ published — now: npm trust github ${real.name} --file semantic-release.yml --repo anolilab/lunora --env release`);
            } catch (error) {
                console.error(`   ✗ ${real.name}: npm publish failed — ${error.message}. Are you logged in (\`npm whoami\`) with publish rights on @lunora?`);
                failures.push(dir);
            }
        }
    } finally {
        rmSync(stage, { force: true, recursive: true });
    }
}

if (failures.length > 0) {
    console.error(`\n${failures.length} package(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
