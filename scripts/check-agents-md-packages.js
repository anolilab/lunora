/**
 * Guards the `AGENTS.md` (`CLAUDE.md` symlinks to it) `### Packages` table
 * against `packages/*` actually existing on disk.
 *
 * AGENTS.md is the file every coding agent reads to decide which package owns
 * a change. A package added or extracted without a table row (or at least a
 * prose mention) is invisible to that decision — five packages (`auth-ui`,
 * `platform`, `platform-cloudflare`, `platform-node`, `shard-engine`) drifted
 * out of the file this way before plan 287 fixed it. This check keeps the fix
 * from silently rotting again.
 *
 * Coverage: `packages/` only — `apps/`, `examples/`, `tests/` are out of
 * scope for the table by design (plan 287 §9 records the decision).
 *
 * Match rule: substring match on the exact manifest `name` anywhere in
 * AGENTS.md — a table cell or a prose mention both count. Parsing the table
 * structure would be more precise but brittle to reformatting; a name that
 * shows up in prose (like the platform-family paragraph) is still coverage a
 * reader can act on, which is what keeps this check honest without being
 * brittle.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");
const agentsMdPath = join(rootDir, "AGENTS.md");

const agentsMd = readFileSync(agentsMdPath, "utf8");

const missing = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
        continue;
    }

    const manifestPath = join(packagesDir, entry.name, "package.json");

    let manifest;

    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
        // Unreadable/missing package.json — nothing to name-check.
        continue;
    }

    if (typeof manifest.name !== "string") {
        continue;
    }

    if (!agentsMd.includes(manifest.name)) {
        missing.push(manifest.name);
    }
}

if (missing.length > 0) {
    console.error(`❌ AGENTS.md does not mention ${missing.length} packages/* package(s):`);

    for (const name of missing.sort()) {
        console.error(`   - ${name}`);
    }

    console.error("   Add a `### Packages` table row (or at least a prose mention) to AGENTS.md.");
    process.exit(1);
}

console.log("✅ AGENTS.md mentions every packages/* package.");
