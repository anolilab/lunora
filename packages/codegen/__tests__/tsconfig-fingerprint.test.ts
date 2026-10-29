import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tsconfigFingerprint } from "../src/codegen-project";

let workdir: string;

const write = (name: string, content: unknown): void => {
    writeFileSync(join(workdir, name), JSON.stringify(content), "utf8");
};

describe("tsconfigFingerprint", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-tsconfig-fingerprint-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("is stable while nothing it resolves to changes", () => {
        expect.assertions(1);

        write("base.json", { compilerOptions: { strict: false } });
        write("tsconfig.json", { extends: "./base.json", include: ["src/**/*"] });

        expect(tsconfigFingerprint(join(workdir, "tsconfig.json"))).toBe(tsconfigFingerprint(join(workdir, "tsconfig.json")));
    });

    it("changes when a config it extends changes its settings, though its own bytes do not", () => {
        expect.assertions(2);

        write("base.json", { compilerOptions: { strict: false } });
        write("tsconfig.json", { extends: "./base.json" });

        const before = tsconfigFingerprint(join(workdir, "tsconfig.json"));

        write("base.json", { compilerOptions: { strict: true } });

        expect(tsconfigFingerprint(join(workdir, "tsconfig.json"))).not.toBe(before);
        expect(tsconfigFingerprint(join(workdir, "tsconfig.json"))).toContain("strict");
    });

    it("changes when a new file matches the include globs", () => {
        expect.assertions(1);

        write("tsconfig.json", { include: ["src/**/*"] });
        writeFileSync(join(workdir, "a.ts"), "", "utf8");
        const before = tsconfigFingerprint(join(workdir, "tsconfig.json"));

        // A new file under src/ is what the include glob picks up.
        mkdirSync(join(workdir, "src"));
        writeFileSync(join(workdir, "src", "globals.d.ts"), "declare const x: number;", "utf8");

        expect(tsconfigFingerprint(join(workdir, "tsconfig.json"))).not.toBe(before);
    });
});
