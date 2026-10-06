import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectUsesUmbrella } from "../src/detect-framework";
import { readProjectDependencies, readProjectManifest } from "../src/project-manifest";

describe("project manifest", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-project-manifest-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const writeManifest = (contents: string): void => {
        writeFileSync(join(root, "package.json"), contents, "utf8");
    };

    it("reads nothing from a missing, malformed or non-object manifest", () => {
        expect.assertions(4);

        expect(readProjectManifest(root)).toBeUndefined();

        writeManifest("{ not json");

        expect(readProjectManifest(root)).toBeUndefined();

        writeManifest("[1, 2]");

        expect(readProjectManifest(root)).toBeUndefined();
        expect(readProjectDependencies(root)).toStrictEqual({});
    });

    it("lets a runtime dependency win a name declared in both sections and drops non-string ranges", () => {
        expect.assertions(1);

        writeManifest(JSON.stringify({ dependencies: { "solid-js": "^2.0.0", typo: 1 }, devDependencies: { "solid-js": "^1.9.0", vite: "^7.0.0" } }));

        expect(readProjectDependencies(root)).toStrictEqual({ "solid-js": "^2.0.0", vite: "^7.0.0" });
    });

    it("ignores a dependency section that is not an object", () => {
        expect.assertions(1);

        writeManifest(JSON.stringify({ dependencies: "lunorash", devDependencies: { lunorash: "1.0.0" } }));

        expect(readProjectDependencies(root)).toStrictEqual({ lunorash: "1.0.0" });
    });

    it("detects the lunorash umbrella in either section", () => {
        expect.assertions(2);

        expect(projectUsesUmbrella(root)).toBe(false);

        writeManifest(JSON.stringify({ devDependencies: { lunorash: "1.0.0" } }));

        expect(projectUsesUmbrella(root)).toBe(true);
    });
});
