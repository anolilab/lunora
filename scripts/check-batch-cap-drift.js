#!/usr/bin/env node
/**
 * Guards the two batch-RPC caps — `MAX_BATCH_ENTRIES` and `MAX_BATCH_BYTES` —
 * against drifting between their definitions and the places that restate them.
 *
 * The eight non-JS ports cannot import anything from this repo, and
 * `protocol/README.md` states both numbers in prose, so every one of them holds its
 * own literal. Nothing reconciled them: the ports only ever see a cap as a number
 * they typed once.
 *
 * That matters more than a stale doc line.
 *
 *   - `MAX_BATCH_ENTRIES`: the server rejects an over-cap batch with a coded 400,
 *     which `protocol/README.md` §4.3 defines as a TERMINAL verdict — a conforming
 *     client DISCARDS those entries rather than retrying them. Lowering the shared
 *     cap without lowering all eight silently turns durable offline writes into
 *     dropped ones on every non-JS client.
 *   - `MAX_BATCH_BYTES`: a client-side budget, and the only one of the two that is
 *     DERIVED — it is the worker's own request-body cap (`MAX_BODY_BYTES` in
 *     `@lunora/runtime`) less a fixed headroom, written as that subtraction in all
 *     nine clients. So it drifts two ways: a client restating a stale total, and
 *     the worker's cap moving underneath every client at once. Over-budget costs a
 *     413, which §4.3 makes a split-and-retry rather than a verdict, so the write
 *     survives — but the flush pays a wasted round trip per chunk, and an
 *     under-budget client chunks far more than it needs to.
 *
 * Both operands of the byte budget are compared, not just the difference: the first
 * IS the worker's cap and the second the framing headroom, so a mirror spelling the
 * same total as `900_000 - 0` would be lying about both.
 *
 * The entry cap is ALSO pinned from the other side, by a normative fixture value
 * (`offlineQueue.batchReplay.maxEntries`) each port reads back in the
 * `batch_entry_cap_matches_protocol` conformance case. The byte budget deliberately
 * gets no such twin. That second mechanism buys one thing this script cannot — proof
 * that each port's RUNNING code reads its own constant — and it is worth eight
 * hand-written test cases only because an over-entry chunk is settled terminally and
 * the writes are gone. A stale byte budget costs a round trip, not a write: §4.3
 * makes the 413 a split-and-retry. Prevention here is what the reconciliation is
 * for, and the reconciliation is this file.
 *
 * The same `scripts/check-*.js` + `lint:*` + lint.yml shape as
 * `check-node-capabilities-docs.js` and `check-roadmap-tiers.js`, which reconcile a
 * constant against its hand-maintained mirrors for the same reason.
 *
 * Fail-closed three times over:
 *   - a pattern that matches NOTHING is an error, not a pass. A renamed or moved
 *     declaration would otherwise quietly reduce this to a check of the copies that
 *     still happen to look the way they did.
 *   - a pattern capturing a different number of groups than the row claims is an
 *     error, so a mirror cannot be silently compared against the wrong operand.
 *   - an SDK directory with no row in a cap's mirrors is an error, so a ninth port
 *     cannot be added with a tenth hardcoded literal that nothing reads.
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

/**
 * Every cap this script reconciles.
 *
 * `sourcePattern` may capture more than one number (the byte budget captures both
 * operands of its subtraction); a mirror's `groups` names which of the source's
 * captures its own captures correspond to, defaulting to all of them in order. A
 * `scale` multiplies a mirror's captures before comparison, for a mirror that
 * states the value in a coarser unit than the source does.
 */
const CAPS = [
    {
        consequence: "a client chunking above the server's cap has its over-cap chunk refused with a terminal 400 and\nDISCARDS those durable writes",
        mirrors: [
            { file: "sdks/python/lunora/submit.py", patterns: [/^MAX_BATCH_ENTRIES = (\d+)$/mu], sdk: "python" },
            { file: "sdks/go/lunora/submit.go", patterns: [/^const MaxBatchEntries = (\d+)$/mu], sdk: "go" },
            { file: "sdks/ruby/lib/lunora/client.rb", patterns: [/^ {2}MAX_BATCH_ENTRIES = (\d+)$/mu], sdk: "ruby" },
            { file: "sdks/rust/src/offline.rs", patterns: [/^pub const MAX_BATCH_ENTRIES: usize = (\d+);$/mu], sdk: "rust" },
            { file: "sdks/swift/Sources/Lunora/Offline.swift", patterns: [/^public let lunoraMaxBatchEntries = (\d+)$/mu], sdk: "swift" },
            { file: "sdks/java/src/dev/lunora/Offline.java", patterns: [/^ {4}public static final int MAX_BATCH_ENTRIES = (\d+);$/mu], sdk: "java" },
            { file: "sdks/kotlin/src/Offline.kt", patterns: [/^const val MAX_BATCH_ENTRIES: Int = (\d+)$/mu], sdk: "kotlin" },
            { file: "sdks/dart/lib/src/transport.dart", patterns: [/^const int lunoraMaxBatchEntries = (\d+);$/mu], sdk: "dart" },
            // The normative prose. Both sentences carry the number; §4.3's is the one
            // that defines the over-cap verdict, so a half-updated README is its own
            // defect. The fixture value the conformance suites read is the third.
            {
                file: "protocol/README.md",
                patterns: [/capped at \*\*(\d+)\*\* entries/u, /chunking by the (\d+)-entry cap/u],
                sdk: undefined,
            },
            { file: "protocol/fixtures/offline-optimistic.json", patterns: [/^ {12}"maxEntries": (\d+),$/mu], sdk: undefined },
        ],
        name: "MAX_BATCH_ENTRIES",
        sourceFile: "shared/batch-wire.ts",
        sourceForm: "const MAX_BATCH_ENTRIES = <n>;",
        sourcePattern: /^const MAX_BATCH_ENTRIES = (\d+);$/mu,
    },
    {
        consequence:
            "a client whose budget no longer matches the worker's body cap either wastes a round trip per\nover-budget chunk or chunks far smaller than it needs to",
        mirrors: [
            { file: "sdks/python/lunora/submit.py", patterns: [/^MAX_BATCH_BYTES = ([\d_]+) - ([\d_]+)$/mu], sdk: "python" },
            { file: "sdks/go/lunora/submit.go", patterns: [/^const MaxBatchBytes = ([\d_]+) - ([\d_]+)$/mu], sdk: "go" },
            { file: "sdks/ruby/lib/lunora/client.rb", patterns: [/^ {2}MAX_BATCH_BYTES = ([\d_]+) - ([\d_]+)$/mu], sdk: "ruby" },
            { file: "sdks/rust/src/offline.rs", patterns: [/^pub const MAX_BATCH_BYTES: usize = ([\d_]+) - ([\d_]+);$/mu], sdk: "rust" },
            { file: "sdks/swift/Sources/Lunora/Offline.swift", patterns: [/^public let lunoraMaxBatchBytes = ([\d_]+) - ([\d_]+)$/mu], sdk: "swift" },
            {
                file: "sdks/java/src/dev/lunora/Offline.java",
                patterns: [/^ {4}public static final int MAX_BATCH_BYTES = ([\d_]+) - ([\d_]+);$/mu],
                sdk: "java",
            },
            { file: "sdks/kotlin/src/Offline.kt", patterns: [/^const val MAX_BATCH_BYTES: Int = ([\d_]+) - ([\d_]+)$/mu], sdk: "kotlin" },
            { file: "sdks/dart/lib/src/transport.dart", patterns: [/^const int lunoraMaxBatchBytes = ([\d_]+) - ([\d_]+);$/mu], sdk: "dart" },
            // The worker's own request-body cap, which the budget's FIRST operand is
            // the client-side restatement of. This is the row the entry cap has no
            // analogue for: raise the server's cap and every client's budget is stale
            // at once, with nothing else in the repo noticing.
            {
                file: "packages/runtime/src/body-readers.ts",
                groups: [1],
                patterns: [/^const MAX_BODY_BYTES = ([\d_]+);$/mu],
                sdk: undefined,
            },
            // The normative prose states the same cap in MiB.
            {
                file: "protocol/README.md",
                groups: [1],
                patterns: [/under the (\d+) MiB cap/u],
                scale: 1024 * 1024,
                sdk: undefined,
            },
        ],
        name: "MAX_BATCH_BYTES",
        sourceFile: "packages/client/src/replay.ts",
        sourceForm: "const MAX_BATCH_BODY_BYTES = <cap> - <headroom>;",
        sourcePattern: /^const MAX_BATCH_BODY_BYTES = ([\d_]+) - ([\d_]+);$/mu,
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

/** The numeric value of one captured literal, in whatever digit-grouping its language spells. */
const numberOf = (literal) => Number(literal.replaceAll("_", ""));

const problems = [];

for (const { mirrors, name, sourceFile, sourceForm, sourcePattern } of CAPS) {
    const sourceMatch = sourcePattern.exec(read(sourceFile));

    if (sourceMatch === null) {
        process.stderr.write(
            `${sourceFile} no longer declares \`${sourceForm}\`.\n` +
                `That declaration is what every other copy of ${name} is measured against, so this check\n` +
                `cannot run. Update its sourcePattern in scripts/check-batch-cap-drift.js to match its new form.\n`,
        );
        process.exit(1);
    }

    const expected = sourceMatch.slice(1).map(numberOf);

    for (const { file, groups = expected.map((_unused, index) => index + 1), patterns, scale = 1 } of mirrors) {
        const source = read(file);

        for (const pattern of patterns) {
            const match = pattern.exec(source);

            if (match === null) {
                problems.push(`  ${name}: ${file} — nothing matches ${String(pattern)}; the declaration moved or was renamed`);
                continue;
            }

            const captured = match.slice(1);

            if (captured.length !== groups.length) {
                problems.push(
                    `  ${name}: ${file} — ${String(pattern)} captures ${String(captured.length)} number(s) but its row claims ${String(groups.length)}`,
                );
                continue;
            }

            for (const [index, literal] of captured.entries()) {
                const actual = numberOf(literal) * scale;
                const want = expected[groups[index] - 1];

                if (actual !== want) {
                    problems.push(`  ${name}: ${file} — states ${String(actual)}, ${sourceFile} states ${String(want)}`);
                }
            }
        }
    }

    const covered = new Set(mirrors.map(({ sdk }) => sdk));

    for (const entry of readdirSync(join(rootDir, "sdks"), { withFileTypes: true })) {
        if (!entry.isDirectory() || IGNORED_SDK_DIRS.has(entry.name)) {
            continue;
        }

        if (!covered.has(entry.name)) {
            problems.push(`  ${name}: sdks/${entry.name} — a port with no row in its mirrors, so its own cap is reconciled by nothing`);
        }
    }
}

if (problems.length > 0) {
    process.stderr.write(
        `The batch caps disagree across ${String(problems.length)} location(s).\n` +
            `Every port and protocol/README.md restates them as literals because they cannot import them,\n` +
            `so they have to change together:\n${problems.join("\n")}\n\n` +
            `${CAPS.map(({ consequence, name, sourceFile }) => `${name} (source of truth: ${sourceFile}) — ${consequence}.`).join("\n\n")}\n`,
    );
    process.exit(1);
}

process.stdout.write(`✅ ${CAPS.map(({ mirrors, name }) => `${name} agrees across its ${String(mirrors.length)} mirrors`).join(", ")}.\n`);
