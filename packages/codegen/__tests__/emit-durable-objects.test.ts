import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitDurableObjects } from "../src/emit/runtime-modules";
import { readProjectConfigLiterals } from "../src/project-config-file";

describe(emitDurableObjects, () => {
    it("re-exports the merge helpers only when the app opts in", () => {
        expect.assertions(3);

        expect(emitDurableObjects(true, false)).toContain('export { mergeDurableObjects, roleNamespace } from "@lunora/do";');
        expect(emitDurableObjects(true, true)).toContain('export { mergeDurableObjects, roleNamespace } from "lunorash/do";');
        // No module, so nothing downstream composes a merged class.
        expect(emitDurableObjects(false, false)).toBe("");
    });
});

describe("durableObjects.merge in lunora.config", () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-merge-config-"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    const writeConfig = (body: string): void => {
        writeFileSync(join(projectRoot, "lunora.config.ts"), `export default ${body};\n`, "utf8");
    };

    it.each([
        ["{ durableObjects: { merge: true } }", { merge: true }],
        ["{ durableObjects: { merge: false } }", { merge: false }],
        ["{ durableObjects: {} }", {}],
        ["{ durableObjects: { merge: process.env.MERGE === '1' } }", { unreadable: true }],
    ])("reads %s", (body, expected) => {
        expect.assertions(1);

        writeConfig(body);

        expect(readProjectConfigLiterals(projectRoot).durableObjects).toStrictEqual(expected);
    });
});
