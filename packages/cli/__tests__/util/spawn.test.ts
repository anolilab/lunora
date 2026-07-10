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

    it("quotes cmd.exe metacharacters even without whitespace so they can't be re-split or run as a second command", () => {
        expect.assertions(1);

        // `&` (and `| < > ^ %`) are unquoted command separators / redirection for
        // cmd.exe: `--outdir C:\Dev&Ops\dist` would otherwise run `Ops\dist`.
        expect(spawnShellCompat("pnpm", ["deploy", "--outdir", String.raw`C:\Dev&Ops\dist`], "win32")).toStrictEqual({
            args: ["deploy", "--outdir", String.raw`"C:\Dev&Ops\dist"`],
            command: "pnpm",
            shell: true,
        });
    });

    it("escapes an embedded double-quote for CommandLineToArgvW", () => {
        expect.assertions(1);

        // An embedded `"` would toggle cmd's quote state and re-split the value;
        // it must reach the child as `\"` inside the wrapping quotes.
        expect(spawnShellCompat("pnpm", ["--msg", 'a"b'], "win32")).toStrictEqual({
            args: ["--msg", String.raw`"a\"b"`],
            command: "pnpm",
            shell: true,
        });
    });

    it("doubles a trailing backslash so it can't escape the closing quote", () => {
        expect.assertions(1);

        // A quoted path ending in `\` (quoted here for the embedded space) would
        // otherwise escape the closing quote and re-split the argument.
        expect(spawnShellCompat("pnpm", ["--dir", "C:\\a b\\"], "win32")).toStrictEqual({
            args: ["--dir", String.raw`"C:\a b\\"`],
            command: "pnpm",
            shell: true,
        });
    });

    it("emits an explicit empty token for an empty argument so following positionals don't shift", () => {
        expect.assertions(1);

        expect(spawnShellCompat("pnpm", ["--flag", "", "tail"], "win32")).toStrictEqual({
            args: ["--flag", `""`, "tail"],
            command: "pnpm",
            shell: true,
        });
    });
});
