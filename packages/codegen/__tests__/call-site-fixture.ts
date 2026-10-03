import type { CallSiteScope } from "../src/ir";

/** The export or helper a scope names — `<module>` at module scope — for picking records in a test. */
export const scopeName = (scope: CallSiteScope): string => (scope.kind === "module" ? "<module>" : scope.name);

/**
 * The 1-based line of the fixture line carrying `// @<marker>`, so a test asserts
 * a discovered line without hard-coding where the fixture text happens to put it.
 */
export const markerLine = (source: string, marker: string): number => {
    const index = source.split("\n").findIndex((line) => line.includes(`// @${marker}`));

    if (index === -1) {
        throw new Error(`fixture has no "// @${marker}" marker`);
    }

    return index + 1;
};
