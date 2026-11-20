/**
 * What the tenant is shown: one advisory per attributed finding, and the caps
 * on how many are reported.
 */
import { createHash } from "node:crypto";

/** @typedef {import("./scan-detect.mjs").RawFinding} RawFinding */
/** @typedef {import("./scan-budget.mjs").ScanLimits} ScanLimits */

/** Longest `file` an advisory carries: a sourcemap's `sources` entry is tenant output, unbounded. */
const MAX_FILE_CHARS = 512;

/**
 * `path`, shortened in the middle when it is over {@link MAX_FILE_CHARS}.
 * @param {string} path A repo-relative path.
 * @returns {string} The path to report.
 */
const cappedPath = (path) => (path.length <= MAX_FILE_CHARS ? path : `${path.slice(0, 250)}…${path.slice(-250)}`);

/**
 * The path as a `cacheKey` spells it: as-is when short, else a prefix plus a
 * digest of the whole path — bounded, and distinct for distinct long paths
 * (the control plane caps the key, so a long shared prefix would collapse them).
 * @param {string} path A repo-relative path.
 * @returns {string} The key part.
 */
const keyPath = (path) => (path.length <= 256 ? path : `${path.slice(0, 200)}#${createHash("sha256").update(path).digest("hex").slice(0, 16)}`);

/**
 * @param {number} ms A delay.
 * @returns {string} It in the largest whole unit that reads naturally.
 */
const formatDelay = (ms) => {
    if (ms % 3_600_000 === 0 && ms > 0) {
        return `${String(ms / 3_600_000)} h`;
    }

    if (ms % 60_000 === 0 && ms > 0) {
        return `${String(ms / 60_000)} min`;
    }

    return ms % 1000 === 0 ? `${String(ms / 1000)} s` : `${String(ms)} ms`;
};

/**
 * The tenant-facing advisory for one attributed finding.
 * @param {RawFinding} finding The raw finding.
 * @param {{ file: string, line: number, location: "bundle" | "source" }} where Its attribution.
 * @returns {{ cacheKey: string, detail: string, file: string, level: "INFO" | "WARN", line: number, location: "bundle" | "source", name: string, remediation: string, title: string }} The advisory.
 */
const advisoryOf = (finding, where) => {
    const file = cappedPath(where.file);
    const place = where.location === "source" ? `${file}:${String(where.line)}` : `line ${String(where.line)} of the built bundle (${file})`;
    const base = {
        cacheKey: `${finding.name}:${keyPath(where.file)}:${String(where.line)}`,
        file,
        level: finding.level ?? "WARN",
        line: where.line,
        location: where.location,
        name: finding.name,
    };

    if (finding.name === "unbounded_loop") {
        return {
            ...base,
            detail: `\`${finding.loopKind ?? "while (true)"}\` at ${place} has no break, return or throw that can leave it, so once it starts it runs until the platform kills the invocation — billing every storage read and write inside it on each pass.`,
            remediation:
                "Give the loop an exit: a counter or deadline that breaks or returns, or `signal.throwIfAborted()`. An `await` inside the loop is not an exit — it only yields, and the loop resumes.",
            title: "Loop with no exit",
        };
    }

    if (finding.name === "alarm_always_rearms" && base.level === "INFO") {
        return {
            ...base,
            detail: `\`alarm()\` re-arms itself every ${formatDelay(finding.delayMs ?? 0)} at ${place} on every run — a periodic job that runs forever by design, waking the Durable Object (and billing it) on each turn.`,
            remediation: "Make sure it has a way to stop: skip the re-arm, or call `storage.deleteAlarm()`, once the object has nothing left to do.",
            title: "Periodic alarm with no way to stop",
        };
    }

    if (finding.name === "alarm_always_rearms") {
        const when = finding.delayMs === undefined ? "after a delay the scan cannot read" : `${formatDelay(finding.delayMs)} later`;

        return {
            ...base,
            detail: `\`alarm()\` calls \`storage.setAlarm(…)\` at ${place} on every run, ${when}, with nothing that can skip it — a tight loop that wakes the Durable Object almost immediately, forever, billing an invocation and its storage operations on every turn.`,
            remediation:
                "Re-arm only while work remains: put `setAlarm` behind a condition, return before it once the work is done, or call `storage.deleteAlarm()` when finished.",
            title: "Alarm re-arms itself almost immediately",
        };
    }

    return {
        ...base,
        detail: `\`queue()\` sends to \`${finding.binding ?? "?"}\` at ${place} on every batch, and that binding produces to \`${finding.queue ?? "?"}\` — the queue this Worker consumes — so every message begets another, forever.`,
        remediation:
            "Re-enqueue only when a message needs another pass (a condition or an attempt counter in the body), use `message.retry()` with a retry limit and a dead-letter queue, or send to a different queue.",
        title: "Queue consumer re-sends to its own queue",
    };
};

/**
 * Hold the findings to the caps — warnings before notes, so a cap drops the
 * gentler ones first — and name whichever cap held some back.
 * @param {ReturnType<typeof advisoryOf>[]} advisories Every attributed finding.
 * @param {ScanLimits} limits The caps.
 * @returns {{ notes: string[], reported: ReturnType<typeof advisoryOf>[] }} What to report, and why some were not.
 */
const applyCaps = (advisories, limits) => {
    const sorted = advisories.toSorted((a, b) => Number(a.level === "INFO") - Number(b.level === "INFO") || a.file.localeCompare(b.file) || a.line - b.line);
    const fromSource = sorted.filter((advisory) => advisory.location === "source");
    const allFromBundle = sorted.filter((advisory) => advisory.location === "bundle");
    const fromBundle = allFromBundle.slice(0, limits.maxBundleFindings);
    const capped = [...fromSource, ...fromBundle];
    const reported = capped.slice(0, limits.maxFindings);
    const overBundleCap = allFromBundle.length - fromBundle.length;
    const overTotalCap = capped.length - reported.length;

    return {
        notes: [
            ...(overBundleCap > 0
                ? [
                      `${String(overBundleCap)} more findings placed only by bundle line not shown (at most ${String(limits.maxBundleFindings)} of those are reported per build)`,
                  ]
                : []),
            ...(overTotalCap > 0 ? [`${String(overTotalCap)} more findings not shown (at most ${String(limits.maxFindings)} are reported per build)`] : []),
        ],
        reported,
    };
};

export { advisoryOf, applyCaps };
