import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { runBin } from "../src/run-bin";

const run = async (argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runBin(
        argv,
        {
            stderr: (text) => {
                stderr += text;
            },
            stdout: (text) => {
                stdout += text;
            },
        },
        { environment: { LUNORA_HOSTD_CONFIG: "/nonexistent/lunora-hostd/config.json" } },
    );

    return { code, stderr, stdout };
};

describe(runBin, () => {
    it("prints the package version", async () => {
        expect.assertions(1);

        const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

        await expect(run(["--version"])).resolves.toStrictEqual({ code: 0, stderr: "", stdout: `${version}\n` });
    });

    it("prints help naming every command", async () => {
        expect.assertions(4);

        const result = await run(["--help"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/lunora-hostd enrol/u);
        expect(result.stdout).toMatch(/lunora-hostd run/u);
        expect(result.stdout).toMatch(/lunora-hostd status/u);
    });

    it("exits non-zero with help for an unknown command or none", async () => {
        expect.assertions(4);

        const none = await run([]);
        const unknown = await run(["frobnicate"]);

        expect(none.code).toBe(1);
        expect(none.stderr).toMatch(/Usage/u);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toMatch(/Usage/u);
    });

    it("refuses to run or report status before the box is enrolled", async () => {
        expect.assertions(4);

        const daemon = await run(["run"]);
        const status = await run(["status"]);

        expect(daemon.code).toBe(1);
        expect(daemon.stderr).toMatch(/enrol this box first/u);
        expect(status.code).toBe(1);
        expect(status.stderr).toMatch(/enrol this box first/u);
    });

    it("does not echo the token when enrol is missing its bucket", async () => {
        expect.assertions(2);

        const result = await run(["enrol", "--token", "secret-token"]);

        expect(result.code).toBe(1);
        expect(result.stderr).not.toMatch(/secret-token/u);
    });
});
