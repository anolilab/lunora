import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveOptions } from "../src/options";
import { LunoraRspackPlugin } from "../src/plugin";

describe("prepareDevSession", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-rspack-dev-session-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(workdir, { force: true, recursive: true });
    });

    it("warns once and carries on when .dev.vars is a directory", async () => {
        expect.assertions(2);

        // `fillDevSecrets` read the directory and threw EISDIR out of the dev session.
        mkdirSync(join(workdir, ".dev.vars"));

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        vi.spyOn(console, "info").mockImplementation(() => {});

        await expect(new LunoraRspackPlugin(resolveOptions({ projectRoot: workdir })).prepareDevSession()).resolves.toBeUndefined();
        expect(warn.mock.calls.filter(([line]) => String(line).includes("EISDIR"))).toHaveLength(1);
    });

    it("writes no .dev.vars when the example it would scaffold from is unreadable", async () => {
        expect.assertions(1);

        mkdirSync(join(workdir, ".dev.vars.example"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "info").mockImplementation(() => {});

        await new LunoraRspackPlugin(resolveOptions({ projectRoot: workdir })).prepareDevSession();

        expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
    });
});
