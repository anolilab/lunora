import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExportCommandOptions, ExportCommandResult } from "../../src/commands/data-transfer";

/**
 * `lunora export`'s handler is a thin adapter, and the one decision it makes on
 * its own is `out: argument[0] ?? options.out` — the positional path wins over
 * the flag. `runExportCommand` itself is covered by `data-transfer.test.ts`, so
 * it is stubbed here and the assertions are on what the handler hands it.
 */
const runExportCommand = vi.fn<(options: ExportCommandOptions) => Promise<ExportCommandResult>>(async () => {
    return { bytes: 0, code: 0, rows: 0 };
});

vi.mock(import("../../src/commands/data-transfer"), async (importOriginal) => {
    return { ...(await importOriginal()), runExportCommand };
});

const { execute } = await import("../../src/commands/export/handler");

type HandlerToolbox = Parameters<typeof execute>[0];

/** A cwd with no `.lunora/project.json`, so the URL resolver finds no link. */
const cwd = join(tmpdir(), "lunora-export-handler-test");

const run = async (argument: string[], options: Record<string, unknown> = {}): Promise<ExportCommandOptions> => {
    await execute({ argument, options, process: { cwd, exit: () => {} } } as unknown as HandlerToolbox);

    const passed = runExportCommand.mock.calls[0]?.[0];

    if (passed === undefined) {
        throw new Error("runExportCommand was not called");
    }

    return passed;
};

describe("lunora export handler", () => {
    beforeEach(() => {
        runExportCommand.mockClear();
    });

    it("uses the positional path as `out`", async () => {
        expect.assertions(1);

        await expect(run(["backup.ndjson"])).resolves.toMatchObject({ out: "backup.ndjson" });
    });

    it("falls back to --out when there is no positional", async () => {
        expect.assertions(1);

        await expect(run([], { out: "flag.ndjson" })).resolves.toMatchObject({ out: "flag.ndjson" });
    });

    it("prefers the positional over --out when both are supplied", async () => {
        expect.assertions(1);

        await expect(run(["positional.ndjson"], { out: "flag.ndjson" })).resolves.toMatchObject({ out: "positional.ndjson" });
    });

    it("leaves `out` undefined when neither is supplied (stdout default)", async () => {
        expect.assertions(1);

        await expect(run([])).resolves.toMatchObject({ out: undefined });
    });

    it("forwards the remaining options and normalises --prod to a boolean", async () => {
        expect.assertions(1);

        await expect(run([], { tables: "users,messages", token: "t0k", url: "https://worker.example" })).resolves.toMatchObject({
            cwd,
            prod: false,
            tables: "users,messages",
            token: "t0k",
            url: "https://worker.example",
        });
    });

    it("passes prod through when --prod is set", async () => {
        expect.assertions(1);

        await expect(run([], { prod: true, url: "https://worker.example" })).resolves.toMatchObject({ prod: true });
    });
});
