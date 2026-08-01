import { describe, expect, it, vi } from "vitest";

import { defaultSpawner, spawnShellCompat } from "../../src/util/spawn";

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

describe("defaultSpawner", () => {
    // Regression test for the `lunora deploy --format json` corruption bug:
    // `offerMissingSecrets` shells out to `wrangler secret list --format json`
    // on every real deploy via `captureStdoutSilently`. If that capture ever
    // teed to the parent's stdout again, the secret-list JSON would print
    // ahead of the final deploy JSON and break `JSON.parse(stdout)` in CI.
    it("captures a child's stdout without writing it to the parent's stdout when captureStdoutSilently is set", async () => {
        expect.assertions(3);

        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        try {
            const result = await defaultSpawner({
                args: ["-e", "process.stdout.write('secret-list-json-payload')"],
                captureStdoutSilently: true,
                command: process.execPath,
            });

            expect(result.code).toBe(0);
            expect(result.stdout).toBe("secret-list-json-payload");
            expect(writeSpy).not.toHaveBeenCalled();
        } finally {
            writeSpy.mockRestore();
        }
    });

    // `captureStdout` (used by deploy's auto-link URL capture) must keep
    // teeing so interactive users still see live progress — only the silent
    // variant added for parsed-not-displayed output changes behavior.
    it("still tees to the parent's stdout when the caller asks for captureStdout", async () => {
        expect.assertions(3);

        const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        try {
            const result = await defaultSpawner({
                args: ["-e", "process.stdout.write('deploy-progress')"],
                captureStdout: true,
                command: process.execPath,
            });

            expect(result.code).toBe(0);
            expect(result.stdout).toBe("deploy-progress");
            expect(writeSpy).toHaveBeenCalledWith(Buffer.from("deploy-progress"));
        } finally {
            writeSpy.mockRestore();
        }
    });

    // Regression test for the two secret-push paths (`env push`,
    // `deploy`'s mint-and-push flow), which are the only callers of the
    // `input` channel: a child that destroys its stdin and exits before
    // draining it (e.g. `wrangler secret put` failing an auth preflight)
    // used to raise an uncaught EPIPE on the error-less writable stream
    // instead of resolving with the child's real exit code. Platform-timing
    // dependent — if this doesn't crash pre-fix on a given machine, the fix
    // (an attached `error` listener) is still harmless and this stays a
    // regression guard.
    it("resolves with the child's exit code instead of throwing an uncaught EPIPE when the child destroys stdin before draining it", async () => {
        expect.assertions(1);

        const result = await defaultSpawner({
            args: ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(3), 100)"],
            command: process.execPath,
            input: "some-input-that-will-never-be-read",
        });

        expect(result.code).toBe(3);
    });
});
