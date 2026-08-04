#!/usr/bin/env node
/**
 * Guards against `ROADMAP.md` and the API-snapshot guard disagreeing about
 * which stability tier a package is in.
 *
 * Two hand-maintained copies of one taxonomy: `scripts/api-snapshot.js` stamps
 * the tier into every snapshot header (and picks the stability sentence from
 * it), while `ROADMAP.md` publishes the same tiers as the public commitment and
 * hangs the graduation bar off them. They had already drifted by eight packages
 * before anyone noticed — `platform`, `platform-cloudflare`, `shard-engine` and
 * `observability` were Core in the script and absent from the roadmap;
 * `auth-ui`, `notify`, `sql-store` and `dispatch` likewise for Stable adapters.
 *
 * That matters more than untidiness: a published bar that tells an adopter how
 * a package earns its SemVer promise is worthless if the two documents disagree
 * about which promise it has today.
 *
 * Deliberately loose in the same spirit as `check-agents-md-packages.js`: it
 * asserts each covered directory is mentioned somewhere inside the matching
 * tier bullet, not that the lists are formatted identically — Prettier reflows
 * those bullets on every edit.
 *
 * Run on every `pnpm install` via the root `postinstall` script.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The roadmap bullet that publishes each tier, keyed by the script's tier label. */
const BULLETS = {
    core: "**Core (full SemVer at 1.0):**",
    experimental: "**Experimental (excluded from the 1.0 promise",
    "stable-adapter": "**Stable adapters (1.0 if they pass the same gates):**",
};

/**
 * The directory lists from `api-snapshot.js`, read as text.
 *
 * Importing it would run its extraction (it reads every built `dist`), so the
 * arrays are parsed out instead — the same trade `check-agents-md-packages.js`
 * makes by reading manifests rather than resolving the workspace.
 */
const readTiers = () => {
    const source = readFileSync(join(rootDir, "scripts", "api-snapshot.js"), "utf8");

    const dirsOf = (constant) => {
        const block = new RegExp(String.raw`const ${constant} = \[([\s\S]*?)\];`).exec(source);

        if (!block) {
            throw new Error(`check-roadmap-tiers: could not find \`${constant}\` in scripts/api-snapshot.js`);
        }

        return [...block[1].matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]);
    };

    return { core: dirsOf("TIER_1"), experimental: dirsOf("TIER_3"), "stable-adapter": dirsOf("TIER_2") };
};

/** The text of one roadmap tier bullet, from its lead-in to the next bullet. */
const bulletText = (roadmap, lead) => {
    const start = roadmap.indexOf(lead);

    if (start === -1) {
        throw new Error(`check-roadmap-tiers: ROADMAP.md has no bullet starting "${lead}"`);
    }

    const next = roadmap.indexOf("\n    - **", start + lead.length);

    return roadmap.slice(start, next === -1 ? roadmap.indexOf("\n- **", start) : next);
};

const roadmap = readFileSync(join(rootDir, "ROADMAP.md"), "utf8");
const tiers = readTiers();
const problems = [];

for (const [tier, dirs] of Object.entries(tiers)) {
    const text = bulletText(roadmap, BULLETS[tier]);

    for (const dir of dirs) {
        // `lunora` is the `lunorash` umbrella; the roadmap names it by its npm
        // name, which is what a reader would look for.
        const needle = dir === "lunora" ? "lunorash" : dir;

        if (!text.includes(`\`${needle}\``)) {
            problems.push(`  ${needle} — in api-snapshot.js as ${tier}, missing from that tier in ROADMAP.md`);
        }
    }
}

if (problems.length > 0) {
    process.stderr.write(
        `ROADMAP.md and scripts/api-snapshot.js disagree about ${String(problems.length)} package tier(s).\n` +
            `The roadmap publishes the promise; the script enforces it. Fix the roadmap bullet (or the script's tier list):\n` +
            `${problems.join("\n")}\n`,
    );
    process.exit(1);
}
