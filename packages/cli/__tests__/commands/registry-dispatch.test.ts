/**
 * The `lunora registry` cerebro adapter: which parsed options each subcommand
 * forwards to its orchestrator. Asserted here rather than through a real run
 * because the only branch that exercises the source gate is the remote fetch,
 * and a unit test must not reach the network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Toolbox } from "@visulima/cerebro";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { runAddCommand as RunAdd, runBuildIndexCommand as RunBuildIndex, runRegistryViewCommand as RunView } from "../../src/commands/registry";

const runAddCommand = vi.fn<typeof RunAdd>(async () => {
    return { code: 0, items: [] };
});
const runBuildIndexCommand = vi.fn<typeof RunBuildIndex>(async () => {
    return { code: 0, items: [] };
});
const runRegistryViewCommand = vi.fn<typeof RunView>(async () => {
    return { code: 0, items: [] };
});

vi.mock(import("../../src/commands/registry"), () => {
    return { runAddCommand, runBuildIndexCommand, runRegistryViewCommand };
});

const { execute } = await import("../../src/commands/registry/handler");

type RegistryOptionsLike = Record<string, unknown>;

const workdir = mkdtempSync(join(tmpdir(), "lunora-registry-dispatch-"));

const run = async (argument: ReadonlyArray<string>, options: RegistryOptionsLike): Promise<void> => {
    await execute({
        argument: [...argument],
        options,
        process: { cwd: workdir, exit: () => {} },
    } as unknown as Toolbox<Console, RegistryOptionsLike>);
};

describe("lunora registry dispatch", () => {
    beforeEach(() => {
        runAddCommand.mockClear();
        runRegistryViewCommand.mockClear();
    });

    it("forwards --allow-unsafe-source on every subcommand that gates on --source", async () => {
        expect.assertions(3);

        // `sourceGateError` is deliberately one message and one rule across
        // `add`/`list`/`view`, but only two of the three forwarded the override —
        // so `registry list --source <custom> --allow-unsafe-source` refused with a
        // message naming a flag it had just been given.
        await run(["add", "auth"], { allowUnsafeSource: true, source: "file:../local-registry" });
        await run(["list"], { allowUnsafeSource: true, source: "file:../local-registry" });
        await run(["view", "auth"], { allowUnsafeSource: true, source: "file:../local-registry" });

        expect(runAddCommand.mock.calls[0]?.[0]).toMatchObject({ allowUnsafeSource: true });
        expect(runAddCommand.mock.calls[1]?.[0]).toMatchObject({ allowUnsafeSource: true, list: true });
        expect(runRegistryViewCommand.mock.calls[0]?.[0]).toMatchObject({ allowUnsafeSource: true });
    });

    it("leaves the override off when the flag is absent", async () => {
        expect.assertions(1);

        await run(["list"], { source: "file:../local-registry" });

        expect(runAddCommand.mock.calls[0]?.[0]).toMatchObject({ allowUnsafeSource: false });
    });
});
