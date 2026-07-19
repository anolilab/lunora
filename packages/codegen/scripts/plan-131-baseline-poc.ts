/**
 * THROWAWAY PROTOTYPE — Plan 131 (advisor autofix + baseline design spike).
 *
 * Not part of `@lunora/codegen`'s public API (nothing under `src/index.ts`
 * imports this directory) — lives under `scripts/`, outside `src/` and outside
 * the package's `tsconfig.json` `include`, so it is neither type-checked as
 * part of `tsc --noEmit` nor bundled into `dist/` by packem. It proves a
 * suppression/baseline path: a real finding on `apps/playground`
 * (`queue_without_dlq:notifications`, still present after the fixer PoC in
 * `plan-131-fixer-poc.ts`) gets acknowledged via a baseline file with an audit
 * trail (reason/by/at) and is excluded from the findings `runAdvisor` (via
 * codegen's `lintSchema`) produced. See `plans/131-phase0-design.md` for the
 * design this de-risks.
 *
 * Lives under `packages/codegen/`, not `packages/advisor/`, even though it
 * demonstrates an advisor-level concept: it needs `runCodegen` to get real
 * findings for the playground schema, and `@lunora/advisor` must not depend
 * on `@lunora/codegen` (codegen already depends on advisor — the reverse edge
 * would be circular). Self-importing codegen's own built public entry (as
 * `plan-131-fixer-poc.ts` does) avoids that boundary violation.
 *
 * Run with: `node --experimental-strip-types packages/codegen/scripts/plan-131-baseline-poc.ts`
 * (requires `pnpm run build:packages` first — no `tsconfig` `paths` hack maps
 * `@lunora/codegen` to source here, unlike when this lived under `src/`.)
 *
 * Safe to delete — do not import from here in real code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Finding } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";

// `import.meta.dirname` needs Node ^22.16/^24.0; the workspace floor is
// ^22.15.0, so resolve the throwaway script's own directory the portable way.
const HERE = dirname(fileURLToPath(import.meta.url));

/** One acknowledged finding, keyed by the finding's stable `cacheKey`. */
interface BaselineEntry {
    /** ISO-8601 timestamp of acknowledgement — the audit trail's "when". */
    acknowledgedAt: string;
    /** Who acknowledged it — the audit trail's "who". */
    acknowledgedBy: string;
    /** The finding's `cacheKey`, exactly as emitted by the lint. */
    cacheKey: string;
    /** Why this finding is acceptable to leave unfixed — the audit trail's "why". */
    reason: string;
}

interface Baseline {
    entries: ReadonlyArray<BaselineEntry>;
}

interface ApplyBaselineResult {
    /** Findings that remain after removing every baseline-acknowledged one. */
    findings: Finding[];
    /** The findings that were removed, paired with the entry that acknowledged them. */
    suppressed: ReadonlyArray<{ entry: BaselineEntry; finding: Finding }>;
}

/**
 * Pure filter: exclude every finding whose `cacheKey` has a matching baseline
 * entry, keeping the rest untouched (order-preserving). This is the shape a
 * real `runAdvisor(context, { baseline })` option would delegate to — the PoC
 * wraps the real `runAdvisor` (invoked here indirectly via `runCodegen`'s
 * `lintSchema` call) rather than editing `@lunora/advisor/src/index.ts`,
 * since modifying the shipped function is real-feature work, out of scope for
 * a throwaway spike.
 */
const applyBaseline = (findings: ReadonlyArray<Finding>, baseline: Baseline): ApplyBaselineResult => {
    const byCacheKey = new Map(baseline.entries.map((entry) => [entry.cacheKey, entry]));
    const kept: Finding[] = [];
    const suppressed: { entry: BaselineEntry; finding: Finding }[] = [];

    for (const finding of findings) {
        const entry = byCacheKey.get(finding.cacheKey);

        if (entry === undefined) {
            kept.push(finding);
        } else {
            suppressed.push({ entry, finding });
        }
    }

    return { findings: kept, suppressed };
};

const PROJECT_ROOT = join(HERE, "../../../apps/playground");
const BASELINE_PATH = join(HERE, "plan-131-baseline.demo.json");

/* eslint-disable no-console -- this is a stdout-reporting CLI-style PoC script, not library code. */
const main = (): void => {
    console.log("=== Plan 131 baseline/suppression PoC: queue_without_dlq on apps/playground ===\n");

    const result = runCodegen({ projectRoot: PROJECT_ROOT });
    const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;

    console.log(`Without baseline: ${result.advisories.length.toString()} advisories:`);

    for (const finding of result.advisories) {
        console.log(`  - ${finding.cacheKey}`);
    }

    const { findings, suppressed } = applyBaseline(result.advisories, baseline);

    console.log(`\nWith baseline (${baseline.entries.length.toString()} entries):`);
    console.log(`  kept: ${findings.length.toString()} advisories:`);

    for (const finding of findings) {
        console.log(`    - ${finding.cacheKey}`);
    }

    console.log(`  suppressed: ${suppressed.length.toString()} finding(s):`);

    for (const { entry, finding } of suppressed) {
        console.log(`    - ${finding.cacheKey}`);
        console.log(`        acknowledgedBy: ${entry.acknowledgedBy}`);
        console.log(`        acknowledgedAt: ${entry.acknowledgedAt}`);
        console.log(`        reason: ${entry.reason}`);
    }

    const stillPresent = findings.some((finding) => finding.cacheKey === "queue_without_dlq:notifications");

    console.log(
        stillPresent ? "\nFAIL — baseline-acknowledged finding is still in the output." : "\nPASS — baseline-acknowledged finding is excluded from the output.",
    );
};

main();
