/**
 * Publish a minimal placeholder version of a package so its npm name exists.
 *
 * Why: npm **trusted publishing** (OIDC) can only be configured for a package
 * that already exists on the registry. A brand-new `@lunora/*` name 404s, so we
 * publish a tiny `0.0.0` placeholder once to claim it — then configure the
 * trusted publisher on npmjs.com and let CI ship the real `1.0.0-alpha.x` with
 * provenance.
 *
 * The placeholder ships **no source** — only a `package.json` + README written
 * to a temp dir — so it can never be mistaken for a usable release.
 *
 * Manual placeholder publishes run WITHOUT provenance on purpose (provenance
 * needs the CI OIDC environment; a local `npm publish --provenance` would fail).
 *
 * Usage (after `npm login` with publish rights on the @lunora scope):
 *   node scripts/publish-name-placeholder.mjs                       # default: bindings, queue
 *   node scripts/publish-name-placeholder.mjs @lunora/bindings      # explicit
 *   DRY_RUN=1 node scripts/publish-name-placeholder.mjs             # print, don't publish
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_VERSION = "0.0.0";

/** Default packages that still need their npm name claimed (dir names under packages/). */
const DEFAULT_TARGETS = ["bindings", "queue"];

/** Resolve a CLI arg (npm name or bare dir) to its packages/<dir>. */
const toDirName = (arg) => arg.replace(/^@lunora\//u, "");

const targets = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS).map(toDirName);
const dryRun = process.env.DRY_RUN === "1";

for (const dir of targets) {
    const realPath = join(ROOT, "packages", dir, "package.json");
    const real = JSON.parse(readFileSync(realPath, "utf8"));

    if (real.private) {
        console.log(`⏭  ${real.name} is private — skipping (it is never published).`);

        continue;
    }

    const placeholder = {
        name: real.name,
        version: PLACEHOLDER_VERSION,
        description: `Placeholder to reserve the npm name. Real releases are published from CI — install the latest version.`,
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
            `# ${real.name}\n\nThis \`${PLACEHOLDER_VERSION}\` is a name-reservation placeholder. Install the latest published version for real code.\n`,
        );

        console.log(`\n📦 ${real.name}@${PLACEHOLDER_VERSION} (placeholder, no provenance) from ${stage}`);

        if (dryRun) {
            console.log("   DRY_RUN=1 — not publishing. package.json:");
            console.log(JSON.stringify(placeholder, null, 2));
        } else {
            execFileSync("npm", ["publish", "--access", "public"], { cwd: stage, stdio: "inherit" });
            console.log(`   ✓ published — now configure its Trusted Publisher on npmjs.com`);
        }
    } finally {
        rmSync(stage, { force: true, recursive: true });
    }
}
