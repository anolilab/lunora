import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Toolbox } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execute } from "../../src/commands/add/handler";
import type { AddOptions } from "../../src/commands/add/index";
import { EXIT_CODE } from "../../src/util/exit-code";
import { setCommandLogger } from "../../src/util/logger";

// __tests__/commands/ -> package root -> packages/ -> monorepo root -> registry/
const testDirectory = dirname(fileURLToPath(import.meta.url));
const registryRoot = resolve(testDirectory, "..", "..", "..", "..", "registry");

const seedProject = (dir: string): void => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, null, 4), "utf8");
    writeFileSync(join(dir, "wrangler.jsonc"), '{\n    // demo\n    "name": "demo"\n}\n', "utf8");
    mkdirSync(join(dir, "lunora"), { recursive: true });
    writeFileSync(join(dir, "lunora", "schema.ts"), "export const schema = {};\n", "utf8");
};

/** A cerebro toolbox stub wired with the options `execute` reads, plus an exit spy. */
const runExecute = async (workdir: string, options: Partial<AddOptions>, argument: string[]): Promise<number | undefined> => {
    let exitCode: number | undefined;
    const toolbox = {
        argument,
        commandName: "add",
        options,
        process: {
            cwd: workdir,
            exit: (code: number): void => {
                exitCode = code;
            },
        },
    } as unknown as Toolbox<Console, AddOptions>;

    await execute(toolbox);

    return exitCode;
};

let workdir: string;
let logged: string[];

describe("lunora add --format", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-add-format-"));
        seedProject(workdir);

        // `add` logs through the shared pail (and, in json mode, through the
        // stderr logger) — neither of which this suite can inject via the
        // toolbox stub. Without the override its whole plan/next-steps
        // transcript went to the real streams, on top of the test reporter's
        // own output.
        logged = [];
        setCommandLogger({
            error: (message) => logged.push(message),
            info: (message) => logged.push(message),
            success: (message) => logged.push(message),
            warn: (message) => logged.push(message),
        });
    });

    afterEach(() => {
        setCommandLogger(undefined);
        rmSync(workdir, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    it("emits a single JSON object containing the applied items on stdout", async () => {
        expect.assertions(3);

        const stdout: string[] = [];
        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
            stdout.push(String(chunk));

            return true;
        });

        const exitCode = await runExecute(workdir, { format: "json", from: registryRoot, yes: true }, ["email"]);

        writeSpy.mockRestore();

        expect(exitCode).toBe(0);

        const json = JSON.parse(stdout.join("")) as { code: number; data: { items: string[] } };

        expect(json.code).toBe(0);
        expect(json.data.items).toStrictEqual(["mail"]);
    });

    // The refusal is `defineHandler`'s, not this command's — asserted through a
    // real command so the wiring (cerebro's command name reaching the message,
    // nothing running past the gate) is covered end to end.
    it("rejects an invalid --format value with the usage exit code", async () => {
        expect.assertions(2);

        const exitCode = await runExecute(workdir, { format: "xml", from: registryRoot, yes: true }, ["email"]);

        expect(exitCode).toBe(EXIT_CODE.USAGE);
        expect(logged).toContain('add: unknown --format "xml" — expected pretty | json');
    });
});
