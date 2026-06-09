import type { Finding, Lint } from "./types";

/** The per-occurrence parts a lint supplies; the rest is inherited from the {@link Lint}. */
type Occurrence = Partial<Pick<Finding, "categories" | "facing" | "level">> & Pick<Finding, "cacheKey" | "detail" | "metadata">;

/**
 * Build a {@link Finding} by inheriting the shared metadata (`name`, `title`,
 * `description`, `remediation`, and the default `level`/`facing`/`categories`)
 * from the owning `lint`, overlaying only the per-occurrence `detail`,
 * `metadata`, and `cacheKey`. A lint may still override severity/facing/category
 * for a specific occurrence by passing them in `occurrence`.
 */
const emit = (lint: Lint, occurrence: Occurrence): Finding => {
    return {
        cacheKey: occurrence.cacheKey,
        categories: occurrence.categories ?? lint.categories,
        description: lint.description,
        detail: occurrence.detail,
        facing: occurrence.facing ?? lint.facing,
        level: occurrence.level ?? lint.level,
        metadata: occurrence.metadata,
        name: lint.name,
        remediation: lint.remediation,
        title: lint.title,
    };
};

export default emit;
