import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import resolveSchemaDirectory from "../src/resolve-schema-directory";

describe(resolveSchemaDirectory, () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-schema-dir-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("defaults to lunora without a vite config", () => {
        expect.assertions(1);

        expect(resolveSchemaDirectory(root)).toBe("lunora");
    });

    it("reads the schemaDir literal passed to the lunora() plugin", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "vite.config.ts"),
            `import { defineConfig } from "vite";\nimport { lunora } from "@lunora/vite";\n\nexport default defineConfig({ plugins: [lunora({ schemaDir: "backend" })] });\n`,
        );

        expect(resolveSchemaDirectory(root)).toBe("backend");
    });

    it("follows an aliased plugin import", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "vite.config.mts"),
            `import { lunora as backend } from "@lunora/vite";\n\nexport default { plugins: [backend({ schemaDir: \`server\` })] };\n`,
        );

        expect(resolveSchemaDirectory(root)).toBe("server");
    });

    it("falls back to lunora for a computed value or another plugin's schemaDir", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "vite.config.ts"),
            `import { lunora } from "@lunora/vite";\nimport other from "other";\nconst directory = "backend";\n\nexport default { plugins: [other({ schemaDir: "nope" }), lunora({ schemaDir: directory })] };\n`,
        );

        expect(resolveSchemaDirectory(root)).toBe("lunora");
    });
});
