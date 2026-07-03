import { describe, expect, it } from "vitest";

import { spawnShellCompat } from "../../src/util/spawn";

describe("spawnShellCompat", () => {
    it("passes through untouched on POSIX", () => {
        expect.assertions(1);

        expect(spawnShellCompat("pnpm", ["run", "dev"], "linux")).toStrictEqual({ args: ["run", "dev"], command: "pnpm", shell: false });
    });

    it("enables the shell for package-manager shims on Windows", () => {
        expect.assertions(1);

        // pnpm/npx/yarn/bun are .cmd shims there — spawn() without a shell
        // fails outright (EINVAL / ENOENT) and the child never gets a PID.
        expect(spawnShellCompat("pnpm", ["run", "dev"], "win32")).toStrictEqual({ args: ["run", "dev"], command: "pnpm", shell: true });
    });

    it("never shells out for node itself, even on Windows", () => {
        expect.assertions(1);

        // process.execPath is a real executable; the daemon re-invocation
        // must not pick up cmd.exe quoting semantics.
        expect(spawnShellCompat(process.execPath, ["bin.mjs", "dev"], "win32")).toStrictEqual({
            args: ["bin.mjs", "dev"],
            command: process.execPath,
            shell: false,
        });
    });

    it("double-quotes whitespace-bearing arguments for cmd.exe", () => {
        expect.assertions(1);

        // With shell:true Node joins command + args verbatim — an unquoted
        // spaced path (e.g. a --config temp file under "C:\Users\John Doe")
        // would be re-split by cmd.exe.
        expect(spawnShellCompat("pnpm", ["exec", "wrangler", "dev", "--config", String.raw`C:\Users\John Doe\app\w.jsonc`], "win32")).toStrictEqual({
            args: ["exec", "wrangler", "dev", "--config", String.raw`"C:\Users\John Doe\app\w.jsonc"`],
            command: "pnpm",
            shell: true,
        });
    });
});
