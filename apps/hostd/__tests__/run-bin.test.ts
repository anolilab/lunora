import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { runBin } from "../src/run-bin";

const run = (argv: string[]): { code: number; stderr: string; stdout: string } => {
    let stdout = "";
    let stderr = "";
    const code = runBin(argv, {
        stderr: (text) => {
            stderr += text;
        },
        stdout: (text) => {
            stdout += text;
        },
    });

    return { code, stderr, stdout };
};

describe(runBin, () => {
    it("prints the package version", () => {
        const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

        expect(run(["--version"])).toStrictEqual({ code: 0, stderr: "", stdout: `${version}\n` });
    });

    it("prints help", () => {
        const result = run(["--help"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/--version/u);
    });

    it("refuses everything else without echoing the arguments", () => {
        const result = run(["enrol", "--token", "secret-token"]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/not implemented yet: enrol\/run arrive with plan 458 W4/u);
        expect(result.stderr).not.toMatch(/secret-token/u);
    });

    it("exits non-zero with help when given no arguments", () => {
        const result = run([]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/Usage/u);
    });
});
