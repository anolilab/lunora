import { byCodepoint } from "./score-advisor";
import type { AdvisorMap, CheckResult, Coverage } from "./types";

/** Every verdict `Coverage` may take, for validating an artifact read off disk. */
const COVERAGE_VALUES: ReadonlySet<string> = new Set<Coverage>(["clean", "exempt", "failing", "warned"]);

/** One procedure whose score moved between the baseline and the current map. */
interface ProcedureDelta {
    /** Score in the current map. */
    after: number;
    /** Score in the baseline. */
    before: number;
    /** `file#exportName`. */
    id: string;
}

/**
 * The verdict a CI gate acts on.
 *
 * A discriminated union on purpose: the obvious shape (a flat object with
 * `comparable: boolean` and `regressed: false` when incomparable) reads as
 * "no regression" for a missing, stale, or corrupt baseline, so a gate written
 * as `if (diff.regressed)` silently passes forever after a `MAP_VERSION` bump.
 * Forcing the caller to narrow makes that mistake unrepresentable.
 */
type BaselineComparison =
    | {
          comparable: false;
          /** Why no comparison was possible — a gate should treat this as "cannot verify", not "clean". */
          reason: "version-mismatch";
      }
    | {
          comparable: true;
          /** Procedures present in both maps whose score fell, sorted by `id`. */
          dropped: ProcedureDelta[];
          /** Procedures that are `failing` now and were not before — new rows included. */
          newFailing: string[];

          /** `true` when the project bucket gained rules or occurrences, even if its saturated score did not move. */
          projectRegressed: boolean;
          /** `true` when any signal above fired. */
          regressed: boolean;
          /** Current global score less the baseline's; negative is a regression. */
          scoreDelta: number;

          /**
           * Procedures whose score held but whose findings grew — a new rule fired,
           * or an existing one fired at more call sites. Scoring charges a rule once
           * however many times it fires, so without this signal "same rule, five more
           * violations" would look identical to the baseline.
           */
          worsened: string[];
      };

/**
 * Did this bucket's findings grow? True when a rule fired that wasn't there
 * before, or an existing rule fired at more call sites.
 *
 * Needed because the score charges a rule once however many times it fires: five
 * new SSRF sites under an already-firing rule move neither the procedure score
 * nor the saturated project score, and would otherwise pass the gate untouched.
 */
const checksWorsened = (before: ReadonlyArray<CheckResult>, after: ReadonlyArray<CheckResult>): boolean => {
    const previous = new Map(before.map((check) => [check.name, check.occurrences]));

    return after.some((check) => check.occurrences > (previous.get(check.name) ?? 0));
};

/** A finite number, i.e. one that can be compared and round-tripped through JSON. */
const isScore = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

/**
 * Structural check for a `checks` array read off disk — container *and* entries.
 *
 * `checksWorsened` is the only thing a baseline's checks reach: it keys a `Map`
 * on `name` and compares `occurrences` with `>`. Validating just the container
 * leaves the same defect one level in — a `null` entry throws there, and a
 * non-numeric `occurrences` makes every comparison `false`, so the growth signal
 * reads "no regression" for a baseline that is corrupt. `level` and `weight` go
 * unchecked on purpose: nothing reads them off a baseline, and rejecting a row
 * over a field the gate never touches would fail runs that can still be verified.
 */
const isCheckList = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) {
            return false;
        }

        const check = entry as Record<string, unknown>;

        return typeof check.name === "string" && isScore(check.occurrences);
    });

/** Structural check for one row of a baseline read off disk. */
const isProcedureRow = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const row = value as Record<string, unknown>;

    // `checks` is validated for the same reason as the other three:
    // `compareToBaseline` hands it to `checksWorsened`, which calls `.map` on it.
    // `?? []` only covers `null`/`undefined`, so a `checks: {}` left by a
    // truncated or merge-conflicted artifact would throw inside the CI gate.
    return typeof row.id === "string" && isScore(row.score) && typeof row.coverage === "string" && COVERAGE_VALUES.has(row.coverage) && isCheckList(row.checks);
};

/** Structural check for the project bucket of a baseline read off disk. */
const isProjectBucket = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const bucket = value as Record<string, unknown>;

    return isCheckList(bucket.checks) && isScore(bucket.score);
};

/**
 * Diff a freshly-scored map against a committed one.
 *
 * Five independent regression signals, any of which fails a gate: the global
 * score fell, a procedure that existed before got worse, a procedure started
 * failing, a procedure's findings grew without its score moving, or the project
 * bucket gained findings. The per-procedure signals matter because a refactor can
 * leave the global mean flat while gutting one handler; the growth signals matter
 * because a rule is charged once however many times it fires, and the project
 * score saturates at 0 — without them, new violations would be free.
 */
const compareToBaseline = (current: AdvisorMap, baseline: AdvisorMap): BaselineComparison => {
    if (baseline.version !== current.version) {
        return { comparable: false, reason: "version-mismatch" };
    }

    const before = new Map(baseline.procedures.map((entry) => [entry.id, entry]));
    const dropped: ProcedureDelta[] = [];
    const newFailing: string[] = [];
    const worsened: string[] = [];

    for (const entry of current.procedures) {
        if (entry.coverage === "exempt") {
            continue;
        }

        const previous = before.get(entry.id);

        if (previous !== undefined && previous.coverage !== "exempt" && entry.score < previous.score) {
            dropped.push({ after: entry.score, before: previous.score, id: entry.id });
        }

        if (entry.coverage === "failing" && previous?.coverage !== "failing") {
            newFailing.push(entry.id);
        }

        if (checksWorsened(previous?.checks ?? [], entry.checks)) {
            worsened.push(entry.id);
        }
    }

    dropped.sort((a, b) => byCodepoint(a.id, b.id));
    newFailing.sort(byCodepoint);
    worsened.sort(byCodepoint);

    const scoreDelta = current.score - baseline.score;
    const projectRegressed = checksWorsened(baseline.project.checks, current.project.checks);

    return {
        comparable: true,
        dropped,
        newFailing,
        projectRegressed,
        regressed: scoreDelta < 0 || dropped.length > 0 || newFailing.length > 0 || worsened.length > 0 || projectRegressed,
        scoreDelta,
        worsened,
    };
};

/**
 * Narrow a parsed `lunora.advisor.map.json` to an {@link AdvisorMap}, returning
 * `undefined` when it is not one this build can read.
 *
 * Validates *shape* — the header and every procedure row — because
 * `compareToBaseline` dereferences `entry.id` / `entry.score` /
 * `entry.coverage` / `entry.checks`: a truncated or merge-conflicted baseline
 * with a `null` row would otherwise crash the gate, and a row of `{}` would
 * compare as a silent no-op. Non-finite scores are rejected for the same
 * reason — `NaN < 0` is `false`, which reads as "no regression".
 *
 * Version *policy* deliberately lives in {@link compareToBaseline}, not here.
 * Rejecting a mismatch in both places made that function's `comparable: false`
 * arm unreachable through every shipped path, so the union that exists to stop a
 * stale baseline reading as "clean" was never exercised. Here we only require a
 * version to be present and finite.
 */
const parseAdvisorMap = (value: unknown): AdvisorMap | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;

    if (!isScore(candidate.version) || !isScore(candidate.score)) {
        return undefined;
    }

    if (!Array.isArray(candidate.procedures) || !candidate.procedures.every((row: unknown) => isProcedureRow(row))) {
        return undefined;
    }

    if (!isProjectBucket(candidate.project)) {
        return undefined;
    }

    return value as AdvisorMap;
};

export { compareToBaseline, parseAdvisorMap };
export type { BaselineComparison, ProcedureDelta };
