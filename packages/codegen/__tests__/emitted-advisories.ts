/**
 * Read back the advisories the way the generated shard rehydrates them:
 * per-finding rows merged over the once-emitted per-rule text.
 *
 * Not a `*.test.ts` file, so vitest does not collect it as a suite.
 */
import emittedJsonData from "./emitted-json-data";

const emittedAdvisories = (source: string): unknown[] => {
    const rules = emittedJsonData(source, "LUNORA_ADVISORY_RULES") as Record<string, object>;

    return (emittedJsonData(source, "LUNORA_ADVISORY_ROWS") as { name: string }[]).map((row) => {
        return { ...rules[row.name], ...row };
    });
};

export default emittedAdvisories;
