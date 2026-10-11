/**
 * The build-time scan of a built Worker bundle (warnings only, never a failure).
 *
 * It looks for code that, once started, can run without end and bill storage
 * operations on every pass: a Durable Object alarm that re-arms itself on every
 * run will wake its object forever, and a loop with no way out inside one turns
 * a single invocation into an unbounded stream of reads and writes. The scan
 * reads the one module `lunora build` produced, so it sees exactly what deploys.
 *
 * Three detectors, all over one acorn parse of that module.
 * `unbounded_loop`: `while (true)`, `for (;;)`, `for (; true;)` or
 * `do … while (true)` with no statically reachable exit (see `hasExit` in `scan-loops.mjs`).
 * `alarm_always_rearms`: a class method named `alarm` that calls
 * `<anything>.storage.setAlarm(…)` at a position that runs on every call.
 * `queue_self_resend`: a `queue(batch, env)` handler that unconditionally sends
 * to a producer binding the release manifest maps to a queue this same Worker
 * consumes.
 *
 * Conservative by construction: a guard is assumed wherever one might be, so a
 * report is something the code really does on every pass. The jump and guard
 * rules are a port of the codegen analyses (`discover/jumps.ts`,
 * `discover/unbounded-loops.ts`, `conditionalPosition` in
 * `discover/call-edges.ts`) from ts-morph to ESTree, and the tests carry their
 * case tables over so the two keep agreeing.
 *
 * Noise control: the bundle holds every dependency, and a finding in someone
 * else's code is not one the tenant can act on. Each candidate is mapped
 * through the bundle's sourcemap (wrangler writes `<module>.map` beside the
 * module in `--outdir` mode) and dropped when its original file is under
 * `node_modules`, in generated output (`.wrangler`, `.lunora`) or outside the
 * extracted repository. Without a sourcemap, esbuild's `// <path>` region
 * comments still say which input a statement came from; without either, the
 * finding is kept against the bundle itself and capped harder.
 *
 * Limits, because the build has a 9-minute budget and the bundle is tenant
 * output: a size cap before the (synchronous) parse, a cooperative deadline
 * checked inside every walk, and a cap on how many findings are reported.
 *
 * This module is the entry point and the scan's whole public surface; the
 * work is split by concern across its siblings:
 * - `scan-budget.mjs`: the caps, `ScanError`, and the time and heap checks.
 * - `scan-tree.mjs`: the acorn parse, the parent index and the tree walks.
 * - `scan-jumps.mjs`: jump targets (port of `discover/jumps.ts`).
 * - `scan-guards.mjs`: guarded positions (port of `conditionalPosition`).
 * - `scan-loops.mjs`: `unbounded_loop` (port of `discover/unbounded-loops.ts`).
 * - `scan-alarms.mjs`: `alarm_always_rearms`.
 * - `scan-queues.mjs`: `queue_self_resend`.
 * - `scan-detect.mjs`: the candidate walk and the detectors run together.
 * - `scan-attribution.mjs`: sourcemap and region-comment attribution.
 * - `scan-report.mjs`: the tenant-facing advisories and the report caps.
 *
 * Zero dependencies beyond the vendored parser (`vendor/acorn.mjs`, a verbatim
 * copy of the catalog-pinned release), like the rest of the box.
 */
import { relative, sep } from "node:path";

import { readSourcemap, regionAttributor, sourcemapAttributor } from "./scan-attribution.mjs";
import { budgetCheck, DEFAULT_SCAN_LIMITS, heapAvailable, heapLeftForMap, MIB, ScanError } from "./scan-budget.mjs";
import { candidateLine, detect } from "./scan-detect.mjs";
import { advisoryOf, applyCaps } from "./scan-report.mjs";
import { parseModule, walk } from "./scan-tree.mjs";

/** @typedef {import("./scan-detect.mjs").RawFinding} RawFinding */

/**
 * The raw findings in one module's source — the analysis without any
 * attribution, for the tests and for {@link scanBundle}.
 * @param {string} code A JavaScript module.
 * @param {{ deadline?: number, keep?: (position: { column: number, line: number }) => boolean, manifest?: unknown, now?: () => number }} [options] Deadline (epoch ms), attribution filter, release manifest, clock.
 * @returns {RawFinding[]} The findings, in source order.
 */
const analyzeSource = (code, options = {}) => {
    const check = budgetCheck({
        deadline: options.deadline ?? Number.POSITIVE_INFINITY,
        message: "the scan ran past its time budget",
        now: options.now ?? Date.now,
    });
    const { program, tree } = parseModule(code, check);

    return detect(tree, program, { keep: options.keep ?? (() => true), manifest: options.manifest }).toSorted((a, b) => a.line - b.line || a.column - b.column);
};

/**
 * Scan one built Worker module. Throws a {@link ScanError} (message safe to
 * show) when it cannot: an oversized or unparsable bundle, a malformed
 * sourcemap, or the deadline — the caller logs that as a skipped scan.
 * @param {{ bundle: Buffer, bundleName?: string, bundlePath: string, heapAvailable?: () => number, limits?: Partial<typeof DEFAULT_SCAN_LIMITS>, manifest?: unknown, now?: () => number, project: string, repo: string }} input The module's bytes and path, the release manifest, the project and repo directories (real paths), and — for tests — the free heap and the clock. `bundleName` is what a finding no source names is reported against; by default the bundle's repo-relative path, which a bundle written outside the repo does not have.
 * @returns {Promise<{ advisories: ReturnType<typeof advisoryOf>[], notes: string[], omitted: number }>} What to report, why attribution or the report is incomplete, and how many findings the caps held back.
 */
const scanBundle = async (input) => {
    const limits = { ...DEFAULT_SCAN_LIMITS, ...input.limits };
    const now = input.now ?? Date.now;
    const deadline = now() + limits.timeoutMs;

    if (input.bundle.length > limits.maxBundleBytes) {
        throw new ScanError(`the bundle is ${(input.bundle.length / MIB).toFixed(1)} MiB, over the ${String(limits.maxBundleBytes / MIB)} MiB the scan reads`);
    }

    const free = input.heapAvailable ?? heapAvailable;
    const code = input.bundle.toString("utf8");
    const { note: mapNote, sourcemap } = await readSourcemap(input.bundlePath, code, limits, heapLeftForMap(input.bundle.length, limits, free()));
    const notes = mapNote === undefined ? [] : [mapNote];
    const late = `the scan ran past ${String(limits.timeoutMs / 1000)} s`;
    const budget = { deadline, heapAvailable: free, message: late, now, reserve: limits.heapReserveBytes };
    const { comments, program, tree } = parseModule(code, budgetCheck(budget));
    const check = budgetCheck(budget);

    // Candidate lines first, so the sourcemap pass keeps only what it needs.
    const lines = new Set();

    walk(tree, program, (node) => {
        const line = candidateLine(node);

        if (line !== undefined) {
            lines.add(line);
        }
    });

    const bundleFile = input.bundleName ?? relative(input.repo, input.bundlePath).split(sep).join("/");
    const attribute =
        sourcemap === undefined ? regionAttributor(comments, input.project, input.repo, bundleFile) : sourcemapAttributor(sourcemap, input.repo, lines, check);
    const attributions = new Map();
    const attributionOf = (position) => {
        const key = `${String(position.line)}:${String(position.column)}`;

        if (!attributions.has(key)) {
            attributions.set(key, attribute(position));
        }

        return attributions.get(key);
    };

    const raw = detect(tree, program, { keep: (position) => !("dropped" in attributionOf(position)), manifest: input.manifest });
    const advisories = [];
    const seen = new Map();

    for (const finding of raw) {
        const where = attributionOf(finding);

        if ("dropped" in where) {
            continue;
        }

        const advisory = advisoryOf(finding, where);
        const occurrence = (seen.get(advisory.cacheKey) ?? 0) + 1;

        seen.set(advisory.cacheKey, occurrence);
        advisories.push(occurrence === 1 ? advisory : { ...advisory, cacheKey: `${advisory.cacheKey}:${String(occurrence)}` });
    }

    const { notes: capNotes, reported } = applyCaps(advisories, limits);

    return { advisories: reported, notes: [...notes, ...capNotes], omitted: advisories.length - reported.length };
};

/**
 * The tenant-facing reason a scan was skipped. A {@link ScanError} names its
 * cause; anything else is the box's own bug, logged for the operator and
 * generalised — like `clientError` in `server.mjs`, nothing internal travels.
 * @param {unknown} error Whatever the scan threw.
 * @returns {string} The reason.
 */
const scanFailure = (error) => {
    if (error instanceof ScanError) {
        return error.message;
    }

    process.stderr.write(`internal build-scan failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);

    return "the scanner failed unexpectedly; the platform operator has the details";
};

export { analyzeSource, scanBundle, scanFailure };

export { decodeMappings } from "./scan-attribution.mjs";
export { DEFAULT_SCAN_LIMITS } from "./scan-budget.mjs";
