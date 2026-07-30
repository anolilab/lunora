import { MAP_VERSION } from "./score-advisor";
import type { AdvisorMap } from "./types";

/** One procedure whose score moved between the baseline and the current map. */
export interface ProcedureDelta {
    /** Score in the current map. */
    after: number;
    /** Score in the baseline. */
    before: number;
    /** `file#exportName`. */
    id: string;
}

/** The verdict a CI gate acts on. */
export interface BaselineComparison {
    /**
     * `false` when the baseline's {@link AdvisorMap.version} does not match this
     * build's — the artifact shape changed, so no field below is meaningful and
     * {@link BaselineComparison.regressed} stays `false`. Re-generate the
     * baseline rather than trusting a cross-version diff.
     */
    comparable: boolean;
    /** Procedures present in both maps whose score fell, sorted by `id`. */
    dropped: ProcedureDelta[];
    /** Procedures that are `dark` now and were not before — new rows included. */
    newDark: string[];
    /** `true` when any signal above fired. */
    regressed: boolean;
    /** Current global score less the baseline's; negative is a regression. */
    scoreDelta: number;
}

/**
 * Diff a freshly-scored map against a committed one.
 *
 * Three independent regression signals, any of which fails a gate: the global
 * score fell, a procedure that existed before got worse, or a procedure went
 * `dark`. Per-procedure checks matter because a refactor can leave the global
 * mean flat while quietly gutting one handler — the case a bare `--min-score`
 * threshold misses.
 */
export const compareToBaseline = (current: AdvisorMap, baseline: AdvisorMap): BaselineComparison => {
    if (baseline.version !== current.version) {
        return { comparable: false, dropped: [], newDark: [], regressed: false, scoreDelta: 0 };
    }

    const before = new Map(baseline.procedures.map((entry) => [entry.id, entry]));
    const dropped: ProcedureDelta[] = [];
    const newDark: string[] = [];

    for (const entry of current.procedures) {
        const previous = before.get(entry.id);

        if (entry.coverage === "exempt") {
            continue;
        }

        if (previous !== undefined && previous.coverage !== "exempt" && entry.score < previous.score) {
            dropped.push({ after: entry.score, before: previous.score, id: entry.id });
        }

        if (entry.coverage === "dark" && previous?.coverage !== "dark") {
            newDark.push(entry.id);
        }
    }

    dropped.sort((a, b) => a.id.localeCompare(b.id));
    newDark.sort((a, b) => a.localeCompare(b));

    const scoreDelta = current.score - baseline.score;

    return { comparable: true, dropped, newDark, regressed: scoreDelta < 0 || dropped.length > 0 || newDark.length > 0, scoreDelta };
};

/**
 * Narrow a parsed `lunora.advisor.map.json` to an {@link AdvisorMap}, returning
 * `undefined` when it is not one this build can read. Structural checks only —
 * enough to keep a hand-edited or older baseline from throwing deep inside
 * {@link compareToBaseline}.
 */
export const parseAdvisorMap = (value: unknown): AdvisorMap | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const candidate = value as Partial<AdvisorMap>;

    if (candidate.version !== MAP_VERSION || typeof candidate.score !== "number" || !Array.isArray(candidate.procedures)) {
        return undefined;
    }

    return candidate as AdvisorMap;
};
