/**
 * `advisor.minSeverity` in `lunora.config.*`: the lowest advisory level codegen
 * reports and writes into `_generated/shard.ts`.
 *
 * The static rules include INFO ones that fire once per procedure, so a
 * growing project's advisories are mostly INFO, and the emitted table grows
 * with every procedure. A floor of `"warn"` keeps those out of the terminal, the
 * studio and the generated shard.
 *
 * An ERROR is never below any floor. The gate that fails `lunora codegen`,
 * `deploy` and `vite build` reads the same advisories this filters, so it
 * cannot be switched off from here; `lint: false` remains the only way to skip
 * the advisor entirely.
 */
import type { Finding, Level } from "@lunora/advisor";

import { readProjectConfigLiterals } from "./project-config-file";

/** The values `minSeverity` accepts, and the advisor level each one means. */
const FLOORS: Readonly<Record<string, Level>> = { error: "ERROR", info: "INFO", warn: "WARN" };

const RANK: Readonly<Record<Level, number>> = { ERROR: 2, INFO: 0, WARN: 1 };

/** Reported in place of silently emitting everything when the floor cannot be used. */
const invalidFloor = (detail: string): Finding => {
    return {
        cacheKey: "advisor_min_severity_invalid",
        categories: ["SCHEMA"],
        description:
            "`advisor.minSeverity` in `lunora.config.*` sets the lowest advisory level codegen reports and writes into `_generated/shard.ts`. Codegen reads it by parsing the file, so it has to be a string literal.",
        detail,
        facing: "INTERNAL",
        level: "WARN",
        metadata: {},
        name: "advisor_min_severity_invalid",
        remediation: 'Set `advisor: { minSeverity: "info" | "warn" | "error" }` as a literal on the config\'s default export.',
        title: "`advisor.minSeverity` is not a level codegen can read, so every advisory was reported",
    };
};

/** `advisories` minus those below the project's `advisor.minSeverity`, never dropping an ERROR. */
const applyAdvisorFloor = (projectRoot: string, advisories: ReadonlyArray<Finding>): Finding[] => {
    const { advisor } = readProjectConfigLiterals(projectRoot);

    if (advisor === undefined || (advisor.minSeverity === undefined && advisor.unreadable !== true)) {
        return [...advisories];
    }

    const { minSeverity } = advisor;
    const floor = minSeverity !== undefined && Object.hasOwn(FLOORS, minSeverity) ? FLOORS[minSeverity] : undefined;

    if (floor === undefined) {
        return [
            ...advisories,
            invalidFloor(
                minSeverity === undefined
                    ? "`advisor.minSeverity` is not a string literal codegen can read without evaluating the config: a computed value or key, or a spread that could set or override it."
                    : `\`advisor.minSeverity\` is "${minSeverity}", which is not one of "info", "warn" or "error".`,
            ),
        ];
    }

    return advisories.filter((advisory) => RANK[advisory.level] >= RANK[floor]);
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention
export { applyAdvisorFloor };
