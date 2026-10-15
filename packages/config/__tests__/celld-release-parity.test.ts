/**
 * The parity fixture the Rust daemon's `celld_release` is tested against
 * (`apps/hostd/tests/fixtures/celld-release-config.json`) is the TypeScript's own
 * output: each case still produces exactly its `expected` config, key order
 * included, or exactly its `error`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CelldReleaseManifest, CelldReleaseOptions, CelldReleaseRefusal } from "@lunora/config/celld";
import { celldConfigFromRelease, CelldReleaseConfigError } from "@lunora/config/celld";
import { describe, expect, it } from "vitest";

interface FixtureCase {
    error?: { message: string; refused: CelldReleaseRefusal[] };
    expected?: Record<string, unknown>;
    manifest: CelldReleaseManifest;
    name: string;
    options: CelldReleaseOptions;
}

const cases = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "apps", "hostd", "tests", "fixtures", "celld-release-config.json"), "utf8"),
) as FixtureCase[];

/** What a case produces: the config as JSON text (so key order counts), or the refusal. */
const outcome = (entry: FixtureCase): Pick<FixtureCase, "error"> | { expected: string } => {
    try {
        return { expected: JSON.stringify(celldConfigFromRelease(entry.manifest, entry.options)) };
    } catch (error) {
        if (!(error instanceof CelldReleaseConfigError)) {
            throw error;
        }

        return { error: { message: error.message, refused: [...error.refused] } };
    }
};

const recorded = (entry: FixtureCase): Pick<FixtureCase, "error"> | { expected: string } =>
    entry.expected === undefined ? { error: entry.error } : { expected: JSON.stringify(entry.expected) };

describe("the celld release config parity fixture", () => {
    it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
        expect.assertions(1);
        expect(outcome(entry)).toStrictEqual(recorded(entry));
    });
});
