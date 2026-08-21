/**
 * The line→row transform must validate EVERY import envelope with its line
 * number — not only when a storage/document rewrite is configured. Without
 * that, a corrupted line in a plain `lunora import` fails as a whole-batch
 * server error with no way to find the offending line in a multi-GB NDJSON
 * file. On the no-rewrite path the original string must pass through
 * untouched: re-serialising an unmodified line would churn key order and
 * whitespace for nothing.
 */
import { describe, expect, it } from "vitest";

import { createRowTransformer } from "../../src/commands/data-transfer/import-rows";
import type { StorageRemapReport } from "../../src/commands/data-transfer/storage-remap";

const emptyReport = (): StorageRemapReport => {
    return { ambiguous: [], rewritten: 0, unmigrated: [] };
};

describe("import row transform — envelope validation without a remap", () => {
    it("names the line for an envelope that is not valid JSON", () => {
        expect.assertions(1);

        const transform = createRowTransformer({ report: emptyReport() });

        expect(() => transform('{"table": "users", "doc": {', 3)).toThrow(/line 3: import envelope is not valid JSON/u);
    });

    it("names the line for an envelope missing a string `table`", () => {
        expect.assertions(1);

        const transform = createRowTransformer({ report: emptyReport() });

        expect(() => transform('{"doc":{}}', 7)).toThrow("line 7: import envelope is missing a string `table`");
    });

    it("forwards a valid envelope as the identical original string, not a re-serialisation", () => {
        expect.assertions(1);

        const transform = createRowTransformer({ report: emptyReport() });
        // Key order and spacing deliberately non-canonical: a re-stringify
        // would normalise them, so `toBe` proves the original passed through.
        const line = '{"doc": {"b": 1, "a": 2},  "table": "users"}';

        expect(transform(`  ${line} `, 1)).toBe(line);
    });
});
