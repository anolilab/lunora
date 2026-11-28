import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitCheckIgnore } from "../src/git-check-ignore";

/** When set, the next `git` spawn reports this error instead of running. */
let nextSpawnError: NodeJS.ErrnoException | undefined;

vi.mock(import("node:child_process"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        spawnSync: ((...arguments_: Parameters<typeof actual.spawnSync>) => {
            const error = nextSpawnError;

            if (error !== undefined) {
                nextSpawnError = undefined;

                return { error, output: [], pid: 0, signal: "SIGTERM", status: null, stderr: "", stdout: "" };
            }

            return actual.spawnSync(...arguments_);
        }) as typeof actual.spawnSync,
    };
});

const git = (cwd: string, ...arguments_: string[]): void => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell.
    spawnSync("git", arguments_, { cwd, stdio: "ignore" });
};

describe(gitCheckIgnore, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-check-ignore-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("answers ignored and not ignored inside a repository", () => {
        expect.hasAssertions();

        git(directory, "init", "-q");
        writeFileSync(join(directory, ".gitignore"), ".dev.vars\n");

        expect(gitCheckIgnore(join(directory, ".dev.vars"), { noIndex: false })).toBe("ignored");
        expect(gitCheckIgnore(join(directory, "wrangler.jsonc"), { noIndex: false })).toBe("not-ignored");
    });

    it("reads a tracked file by its patterns only with noIndex", () => {
        expect.hasAssertions();

        git(directory, "init", "-q");
        writeFileSync(join(directory, ".gitignore"), ".dev.vars\n");
        writeFileSync(join(directory, ".dev.vars"), "");
        git(directory, "add", "--force", ".dev.vars");

        expect(gitCheckIgnore(join(directory, ".dev.vars"), { noIndex: false })).toBe("not-ignored");
        expect(gitCheckIgnore(join(directory, ".dev.vars"), { noIndex: true })).toBe("ignored");
    });

    it("answers for a file whose name starts with a dash", () => {
        expect.hasAssertions();

        git(directory, "init", "-q");
        writeFileSync(join(directory, ".gitignore"), "-secret\n");

        expect(gitCheckIgnore(join(directory, "-secret"), { noIndex: false })).toBe("ignored");
    });

    it("is unknown outside a repository", () => {
        expect.hasAssertions();

        expect(gitCheckIgnore(join(directory, ".dev.vars"), { noIndex: false })).toBe("unknown");
    });

    it("tells a git that timed out from one that had no answer", () => {
        expect.hasAssertions();

        nextSpawnError = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });

        expect(gitCheckIgnore(join(directory, ".dev.vars"), { noIndex: false })).toBe("timed-out");
    });
});
