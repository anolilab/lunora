import { tmpdir } from "node:os";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/util/logger";
import PromptCancelledError from "../../src/util/prompt-cancelled";

const errorSpy = vi.fn<Logger["error"]>();
const infoSpy = vi.fn<Logger["info"]>();
const successSpy = vi.fn<Logger["success"]>();
const warnSpy = vi.fn<Logger["warn"]>();

vi.mock(import("../../src/util/logger"), () => {
    const logger: Logger = { error: errorSpy, info: infoSpy, success: successSpy, warn: warnSpy };

    // `loggerForFormat` reads the other two: this stub is not one of the process-
    // stream loggers, so json mode keeps it rather than diverting to stderr.
    return { createLogger: () => logger, createStderrLogger: () => logger, isProcessStreamLogger: () => false };
});

const { defineHandler } = await import("../../src/util/command");

type Handler = ReturnType<typeof defineHandler>;
type HandlerToolbox = Parameters<Handler>[0];

/** Minimal cerebro toolbox stub exposing only the surface `defineHandler` reads. */
const createToolbox = (options: Record<string, unknown> = {}): { exit: ReturnType<typeof vi.fn>; toolbox: HandlerToolbox } => {
    const exit = vi.fn<(code: number) => void>();
    const toolbox = {
        argument: [],
        commandName: "demo",
        options,
        process: { cwd: join(tmpdir(), "lunora-command-test"), exit },
    } as unknown as HandlerToolbox;

    return { exit, toolbox };
};

describe("defineHandler", () => {
    beforeEach(() => {
        errorSpy.mockClear();
        infoSpy.mockClear();
        successSpy.mockClear();
        warnSpy.mockClear();
    });

    it("exits 130 without logging an error when the prompt is cancelled", async () => {
        expect.assertions(2);

        const handler = defineHandler(() => {
            throw new PromptCancelledError();
        });
        const { exit, toolbox } = createToolbox();

        await handler(toolbox);

        expect(exit).toHaveBeenCalledWith(130);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("exits 1 and logs the message on a generic error", async () => {
        expect.assertions(2);

        const handler = defineHandler(() => {
            throw new Error("boom");
        });
        const { exit, toolbox } = createToolbox();

        await handler(toolbox);

        expect(exit).toHaveBeenCalledWith(1);
        expect(errorSpy).toHaveBeenCalledWith("boom");
    });

    it.each([
        ["UNAUTHORIZED", 3],
        ["FORBIDDEN", 4],
        ["NOT_FOUND", 5],
        ["CONFLICT", 6],
        ["TOO_MANY_REQUESTS", 7],
        ["SERVICE_UNAVAILABLE", 8],
        ["LOCAL_DEPENDENCY_MISSING", 9],
        ["CODEGEN_DIAGNOSTIC", 2],
    ])("exits with the taxonomy code for a thrown %s", async (code, expected) => {
        expect.assertions(2);

        const handler = defineHandler(() => {
            throw new LunoraError(code, "nope");
        });
        const { exit, toolbox } = createToolbox();

        await handler(toolbox);

        expect(exit).toHaveBeenCalledWith(expected);
        // Rendered through `renderLunoraError`, so the block carries the message
        // (and the catalog hint, where the code has one).
        expect(errorSpy.mock.calls[0]?.[0]).toContain("nope");
    });

    it("exits with the code the body returns on success", async () => {
        expect.assertions(2);

        const handler = defineHandler(() => {
            return { code: 0 };
        });
        const { exit, toolbox } = createToolbox();

        await handler(toolbox);

        expect(exit).toHaveBeenCalledWith(0);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    // The `--format` contract lives here and nowhere else: every command used to
    // re-validate the raw flag on its own, which is 22 copies of one answer.
    it.each([
        [undefined, "pretty"],
        ["pretty", "pretty"],
        ["json", "json"],
    ])("hands the body the parsed --format for %s", async (raw, expected) => {
        expect.assertions(2);

        let seen: string | undefined;
        const handler = defineHandler(({ format }) => {
            seen = format;

            return { code: 0 };
        });
        const { exit, toolbox } = createToolbox({ format: raw });

        await handler(toolbox);

        expect(seen).toBe(expected);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("exits 2 on an unknown --format without running the body", async () => {
        expect.assertions(3);

        let ran = false;
        const handler = defineHandler(() => {
            ran = true;

            return { code: 0 };
        });
        const { exit, toolbox } = createToolbox({ format: "yaml" });

        await handler(toolbox);

        expect(ran).toBe(false);
        expect(exit).toHaveBeenCalledWith(2);
        // Scoped to the command cerebro is running, so the line names what to fix.
        expect(errorSpy).toHaveBeenCalledWith('demo: unknown --format "yaml" — expected pretty | json');
    });
});
