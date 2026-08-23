/**
 * First end-to-end suite over `lunora sdk generate`, driven entirely through
 * the offline `--from` seam — no test here touches the network. The riskiest
 * behaviours pinned down: the transport is vendored FIRST (a missing transport
 * must not leave a generated surface with nothing under it), the stamp records
 * what was actually copied, test files are filtered out of the vendored copy,
 * and spec validation fails with a directive error naming the path.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execute } from "../../src/commands/sdk/handler";
import type { SdkOptions } from "../../src/commands/sdk/index";

/** A minimal OpenRPC document: one typed result, one untyped placeholder result. */
const SPEC = {
    methods: [
        {
            name: "messages:list",
            params: [{ name: "args", required: true, schema: { additionalProperties: false, properties: { limit: { type: "number" } }, type: "object" } }],
            result: { name: "result", schema: { type: "string" } },
            "x-lunora-function-kind": "query",
        },
        {
            name: "messages:send",
            params: [],
            result: { name: "result", schema: { description: "Result is TS-inferred; best-effort — any JSON." } },
            "x-lunora-function-kind": "mutation",
        },
    ],
};

let workdir: string;
let transportRoot: string;

/** Write the fake python transport: two runtime files + one test file the copy filter must drop. */
const writeTransport = (): void => {
    mkdirSync(join(transportRoot, "python", "lunora"), { recursive: true });
    writeFileSync(join(transportRoot, "python", "lunora", "client.py"), "CLIENT = 1\n", "utf8");
    writeFileSync(join(transportRoot, "python", "lunora", "values.py"), "VALUES = 1\n", "utf8");
    writeFileSync(join(transportRoot, "python", "lunora", "test_client.py"), "assert False\n", "utf8");
};

const writeSpec = (document: unknown): string => {
    const specPath = join(workdir, "openrpc.json");

    writeFileSync(specPath, JSON.stringify(document, undefined, 2), "utf8");

    return specPath;
};

/**
 * Drive the handler through a cerebro toolbox stub, capturing everything the
 * command logs. `defineHandler` builds its own pail logger (it is not
 * injectable), so the log assertions read the captured stdout+stderr instead.
 */
const runSdk = async (options: Partial<SdkOptions>, argument: string[] = ["generate"]): Promise<{ code: number | undefined; output: string }> => {
    let exitCode: number | undefined;
    const chunks: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));

        return true;
    };
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const toolbox = {
        argument,
        options,
        process: {
            cwd: workdir,
            exit: (code: number): void => {
                exitCode = code;
            },
        },
    } as unknown as Toolbox<Console, SdkOptions>;

    try {
        await execute(toolbox);
    } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
    }

    return { code: exitCode, output: chunks.join("") };
};

describe("lunora sdk generate", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-sdk-cmd-"));
        transportRoot = mkdtempSync(join(tmpdir(), "lunora-sdk-from-"));
        writeTransport();
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(transportRoot, { force: true, recursive: true });
    });

    it("vendors the transport (test files filtered), writes the stamp and the generated surface", async () => {
        expect.assertions(7);

        const spec = writeSpec(SPEC);
        const { code, output } = await runSdk({ from: transportRoot, lang: "python", spec });
        const outputDirectory = join(workdir, "sdk", "python");

        expect(code).toBe(0);
        expect(readFileSync(join(outputDirectory, "lunora", "client.py"), "utf8")).toBe("CLIENT = 1\n");
        expect(existsSync(join(outputDirectory, "lunora", "test_client.py"))).toBe(false);

        const stamp = JSON.parse(readFileSync(join(outputDirectory, "lunora-transport.json"), "utf8")) as {
            files: string[];
            language: string;
            ref: string;
            source: string;
            versionMatched: boolean;
        };

        expect(stamp.language).toBe("python");
        expect(stamp.files).toStrictEqual(["lunora/client.py", "lunora/values.py"]);
        // A `--from` working copy has no provenance to claim: `ref` is the
        // literal "local" and the copy is never version-matched.
        expect({ ref: stamp.ref, versionMatched: stamp.versionMatched }).toStrictEqual({ ref: "local", versionMatched: false });

        // The generated python surface lands beside the vendored transport, and
        // the one placeholder-result method is counted in the warning.
        expect({
            surface: existsSync(join(outputDirectory, "lunora_api")),
            warned: output.includes("1 of 2 function(s) return an untyped result"),
        }).toStrictEqual({ surface: true, warned: true });
    });

    it("warns on an empty `methods` array but still writes the SDK, transport included", async () => {
        expect.assertions(3);

        const spec = writeSpec({ methods: [] });
        const { code, output } = await runSdk({ from: transportRoot, lang: "python", spec });

        expect(code).toBe(0);
        expect(output).toContain("declares no methods — writing an empty SDK.");
        expect(existsSync(join(workdir, "sdk", "python", "lunora", "client.py"))).toBe(true);
    });

    it("rejects a JSON file with no `methods` array, naming the path", async () => {
        expect.assertions(2);

        const spec = writeSpec({ openrpc: "1.2.6" });
        const { code, output } = await runSdk({ from: transportRoot, lang: "python", spec });

        expect(code).toBe(1);
        expect(output).toContain(`${spec} is not an OpenRPC document (no \`methods\` array)`);
    });

    it("rejects an unknown --lang with the supported-language list", async () => {
        expect.assertions(2);

        const spec = writeSpec(SPEC);
        const { code, output } = await runSdk({ from: transportRoot, lang: "cobol", spec });

        expect(code).toBe(1);
        expect(output).toContain('unsupported --lang "cobol"');
    });

    it("fails before writing any generated surface when --from lacks the transport", async () => {
        // Exercises the same `carriesTransport` predicate the network fallback
        // uses; the fallback-ref loop itself needs the network and stays
        // untested here.
        expect.assertions(3);

        rmSync(join(transportRoot, "python"), { force: true, recursive: true });
        mkdirSync(join(transportRoot, "python"), { recursive: true });

        const spec = writeSpec(SPEC);
        const { code, output } = await runSdk({ from: transportRoot, lang: "python", spec });
        const outputDirectory = join(workdir, "sdk", "python");

        expect(code).toBe(1);
        expect(output).toContain("is not a python transport");
        // The transport is vendored FIRST: its failure must leave no generated
        // files and no stamp behind in the (created but empty) output directory.
        expect(existsSync(outputDirectory) ? readdirSync(outputDirectory) : []).toStrictEqual([]);
    });
});
