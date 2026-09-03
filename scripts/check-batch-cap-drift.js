#!/usr/bin/env node
/**
 * Guards `MAX_BATCH_ENTRIES` — the batch-RPC entry cap — against drifting between
 * `shared/batch-wire.ts` and the ten places that restate it.
 *
 * The JS client imports the shared constant, so it cannot drift. The eight non-JS
 * ports cannot import anything from this repo, and `protocol/README.md` §4.3 states
 * the number in prose, so all nine hold their own literal. Nothing reconciled them:
 * no conformance case asserts the cap, and the ports only ever see it as a number
 * they typed once.
 *
 * That matters more than a stale doc line. The server rejects an over-cap batch with
 * a coded 400, which `protocol/README.md` §4.3 defines as a TERMINAL verdict — a
 * conforming client DISCARDS those entries rather than retrying them. So lowering
 * the shared cap without lowering all eight silently turns durable offline writes
 * into dropped ones on every non-JS client.
 *
 * The same `scripts/check-*.js` + `lint:*` + lint.yml shape as
 * `check-node-capabilities-docs.js` and `check-roadmap-tiers.js`, which reconcile a
 * constant against its hand-maintained mirrors for the same reason.
 *
 * Fail-closed twice over:
 *   - a pattern that matches NOTHING is an error, not a pass. A renamed or moved
 *     declaration would otherwise quietly reduce this to a check of the copies that
 *     still happen to look the way they did.
 *   - an SDK directory with no entry in MIRRORS is an error, so a ninth port cannot
 *     be added with a tenth hardcoded literal that nothing reads.
 *
 * `pnpm run lint:batch-cap` — deliberately not wired into `postinstall`: that chain
 * fails every CI job at its setup step, with the cause invisible in the job that
 * reports it.
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one definition every other copy is measured against. */
const SOURCE_FILE = "shared/batch-wire.ts";
const SOURCE_PATTERN = /^const MAX_BATCH_ENTRIES = (\d+);$/mu;

/**
 * Every restatement of the cap, as `file` → the patterns whose first capture group
 * is the number. `sdk` names the `sdks/<name>` directory the row covers, so the
 * coverage check below can tell a port with no row from one that is deliberately
 * not a port.
 */
const MIRRORS = [
    { file: "sdks/python/lunora/submit.py", patterns: [/^MAX_BATCH_ENTRIES = (\d+)$/mu], sdk: "python" },
    { file: "sdks/go/lunora/submit.go", patterns: [/^const MaxBatchEntries = (\d+)$/mu], sdk: "go" },
    { file: "sdks/ruby/lib/lunora/client.rb", patterns: [/^ {2}MAX_BATCH_ENTRIES = (\d+)$/mu], sdk: "ruby" },
    { file: "sdks/rust/src/offline.rs", patterns: [/^pub const MAX_BATCH_ENTRIES: usize = (\d+);$/mu], sdk: "rust" },
    { file: "sdks/swift/Sources/Lunora/Offline.swift", patterns: [/^public let lunoraMaxBatchEntries = (\d+)$/mu], sdk: "swift" },
    { file: "sdks/java/src/dev/lunora/Offline.java", patterns: [/^ {4}public static final int MAX_BATCH_ENTRIES = (\d+);$/mu], sdk: "java" },
    { file: "sdks/kotlin/src/Offline.kt", patterns: [/^const val MAX_BATCH_ENTRIES: Int = (\d+)$/mu], sdk: "kotlin" },
    { file: "sdks/dart/lib/src/transport.dart", patterns: [/^const int lunoraMaxBatchEntries = (\d+);$/mu], sdk: "dart" },
    // The normative prose. Both sentences carry the number; §4.3's is the one that
    // defines the over-cap verdict, so a half-updated README is its own defect.
    {
        file: "protocol/README.md",
        patterns: [/capped at \*\*(\d+)\*\* entries/u, /chunking by the (\d+)-entry cap/u],
        sdk: undefined,
    },
];

/**
 * `sdks/` entries that are not a port. Same explicit list as `sdks/lint-all.sh` and
 * `sdks/generated-check.sh`, and for the same reason: a marker-file heuristic SKIPS
 * what it does not match, so a new port that forgot the marker would be absent from
 * both the list and this table with nothing red.
 */
const IGNORED_SDK_DIRS = new Set(["smoke"]);

const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8");

const sourceMatch = SOURCE_PATTERN.exec(read(SOURCE_FILE));

if (sourceMatch === null) {
    process.stderr.write(
        `${SOURCE_FILE} no longer declares \`const MAX_BATCH_ENTRIES = <n>;\`.\n` +
            `That declaration is what every other copy of the cap is measured against, so this check\n` +
            `cannot run. Update SOURCE_PATTERN in scripts/check-batch-cap-drift.js to match its new form.\n`,
    );
    process.exit(1);
}

const expected = sourceMatch[1];
const problems = [];

for (const { file, patterns } of MIRRORS) {
    const source = read(file);

    for (const pattern of patterns) {
        const match = pattern.exec(source);

        if (match === null) {
            problems.push(`  ${file} — nothing matches ${String(pattern)}; the declaration moved or was renamed`);
            continue;
        }

        if (match[1] !== expected) {
            problems.push(`  ${file} — states ${match[1]}, ${SOURCE_FILE} states ${expected}`);
        }
    }
}

const covered = new Set(MIRRORS.map(({ sdk }) => sdk));

for (const entry of readdirSync(join(rootDir, "sdks"), { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_SDK_DIRS.has(entry.name)) {
        continue;
    }

    if (!covered.has(entry.name)) {
        problems.push(`  sdks/${entry.name} — a port with no row in MIRRORS, so its own cap is reconciled by nothing`);
    }
}

if (problems.length > 0) {
    process.stderr.write(
        `MAX_BATCH_ENTRIES disagrees across ${String(problems.length)} location(s).\n` +
            `${SOURCE_FILE} is the source of truth (currently ${expected}); every port and protocol/README.md\n` +
            `restates it as a literal because they cannot import it. Change all of them together — a client\n` +
            `chunking above the server's cap has its over-cap chunk refused with a terminal 400 and DISCARDS\n` +
            `those durable writes:\n${problems.join("\n")}\n`,
    );
    process.exit(1);
}

process.stdout.write(`✅ MAX_BATCH_ENTRIES is ${expected} in ${SOURCE_FILE} and all ${String(MIRRORS.length)} mirrors.\n`);
