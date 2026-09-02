/* eslint-disable no-secrets/no-secrets -- fixtures intentionally contain secret-like strings */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEnvCommand } from "../../src/commands/env/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

interface Recorded {
    errors: string[];
    infos: string[];
    successes: string[];
    warnings: string[];
}

const recordingLogger = (): { logger: Logger; recorded: Recorded } => {
    const recorded: Recorded = { errors: [], infos: [], successes: [], warnings: [] };

    return {
        logger: {
            error: (message) => recorded.errors.push(message),
            info: (message) => recorded.infos.push(message),
            success: (message) => recorded.successes.push(message),
            warn: (message) => recorded.warnings.push(message),
        },
        recorded,
    };
};

let workdir: string;

describe("lunora env", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-env-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("lunora env", () => {
        it("list on a missing .dev.vars reports empty without erroring", async () => {
            expect.assertions(2);

            const { logger, recorded } = recordingLogger();

            const result = await runEnvCommand({ cwd: workdir, logger, subcommand: "list" });

            expect(result.code).toBe(0);
            expect(recorded.infos.join("\n")).toContain("(empty)");
        });

        it("set then list redacts values and persists across calls", async () => {
            expect.assertions(4);

            const { logger, recorded } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "API_KEY", logger, subcommand: "set", value: "supersecret-value" });
            await runEnvCommand({ cwd: workdir, key: "DB_URL", logger, subcommand: "set", value: "postgres://x" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(file).toContain("API_KEY=");
            expect(file).toContain("DB_URL=");

            await runEnvCommand({ cwd: workdir, logger, subcommand: "list" });

            const listed = recorded.infos.join("\n");

            expect(listed).toMatch(/API_KEY=supe\*+/u);
            // Full value never appears in list output.
            expect(listed).not.toContain("supersecret-value");
        });

        it("set preserves comments, blank lines, and untouched entries verbatim", async () => {
            expect.assertions(5);

            const original = ["# Auth secrets", 'AUTH_SECRET="scaffolded"', "", "# provider key (from dashboard)", "RESEND_API_KEY=re_123", ""].join("\n");

            writeFileSync(join(workdir, ".dev.vars"), original, "utf8");

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "AUTH_SECRET", logger, subcommand: "set", value: "updated" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            // Comments and blank lines survive.
            expect(file).toContain("# Auth secrets");
            expect(file).toContain("# provider key (from dashboard)");
            // The targeted key is updated in place.
            expect(file).toContain('AUTH_SECRET="updated"');
            // Untouched entries keep their exact original (unquoted) text.
            expect(file).toContain("RESEND_API_KEY=re_123");
            expect(file).not.toContain('AUTH_SECRET="scaffolded"');
        });

        it("set appends a new key without disturbing existing comments", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, ".dev.vars"), "# heading\nEXISTING=1\n", "utf8");

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "NEW_KEY", logger, subcommand: "set", value: "v" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(file).toContain("# heading");
            expect(file).toContain("EXISTING=1");
            expect(file).toContain('NEW_KEY="v"');
        });

        it("set collapses duplicate KEY= lines to one, agreeing with the last-wins read", async () => {
            expect.assertions(3);

            // Two lines defining the same key — `parseDevVariableEntries` (the
            // shared read path `env get`/`env list` build on) is last-wins, so
            // before this fix a `set` that only rewrote the FIRST duplicate
            // left the untouched second line still winning at read time: a
            // `set` that silently didn't take effect.
            writeFileSync(join(workdir, ".dev.vars"), 'DUPLICATE_KEY="first"\nOTHER=1\nDUPLICATE_KEY="second"\n', "utf8");

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "DUPLICATE_KEY", logger, subcommand: "set", value: "updated" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");
            const matchingLines = file.split("\n").filter((line) => line.startsWith("DUPLICATE_KEY="));

            // Exactly one line now defines the key, at its FIRST original position.
            expect(matchingLines).toStrictEqual(['DUPLICATE_KEY="updated"']);
            expect(file).toContain("OTHER=1");

            // The read path agrees with what was just set.
            const written: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
                written.push(typeof chunk === "string" ? chunk : String(chunk));

                return true;
            });

            try {
                await runEnvCommand({ cwd: workdir, key: "DUPLICATE_KEY", logger, subcommand: "get" });

                expect(written.join("")).toContain("updated");
            } finally {
                spy.mockRestore();
            }
        });

        it("unset removes only the target line, preserving comments and other entries", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, ".dev.vars"), "# keep me\nA=1\nB=2\n", "utf8");

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "unset" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(file).toContain("# keep me");
            expect(file).not.toMatch(/^A=/mu);
            expect(file).toContain("B=2");
        });

        it("get prints the full value to stdout", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "TOKEN", logger, subcommand: "set", value: "abcd1234" });

            const written: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
                let text: string;

                if (typeof chunk === "string") {
                    text = chunk;
                } else if (Buffer.isBuffer(chunk)) {
                    text = chunk.toString("utf8");
                } else {
                    text = String(chunk);
                }

                written.push(text);

                return true;
            });

            try {
                const result = await runEnvCommand({ cwd: workdir, key: "TOKEN", logger, subcommand: "get" });

                expect(result.code).toBe(0);
                expect(written.join("")).toContain("abcd1234");
            } finally {
                spy.mockRestore();
            }
        });

        it.each([
            ["backslash", String.raw`a\b`],
            ["double-quote", 'a"b'],
            ["newline", "a\nb"],
        ])("set rejects a value containing a %s rather than corrupting the round-trip", async (_label, value) => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            const result = await runEnvCommand({ cwd: workdir, key: "SECRET", logger, subcommand: "set", value });

            expect(result.code).toBe(1);
            // Nothing should have been written for a rejected value.
            expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
        });

        it("set then get round-trips a value with shell-special (but representable) characters", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();
            const value = "p@ss w0rd $with=lots&of#chars!";

            await runEnvCommand({ cwd: workdir, key: "DB_PASS", logger, subcommand: "set", value });

            const written: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
                let text: string;

                if (typeof chunk === "string") {
                    text = chunk;
                } else if (Buffer.isBuffer(chunk)) {
                    text = chunk.toString("utf8");
                } else {
                    text = String(chunk);
                }

                written.push(text);

                return true;
            });

            try {
                const result = await runEnvCommand({ cwd: workdir, key: "DB_PASS", logger, subcommand: "get" });

                expect(result.code).toBe(0);
                expect(written.join("")).toBe(`${value}\n`);
            } finally {
                spy.mockRestore();
            }
        });

        it("get on a missing key returns 1", async () => {
            expect.assertions(2);

            const { logger, recorded } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "EXISTING=ok\n", "utf8");

            const result = await runEnvCommand({ cwd: workdir, key: "MISSING", logger, subcommand: "get" });

            expect(result.code).toBe(1);
            expect(recorded.errors.join("\n")).toContain("MISSING");
        });

        it("unset removes a key and is idempotent", async () => {
            expect.assertions(4);

            const { logger, recorded } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "set", value: "1" });
            await runEnvCommand({ cwd: workdir, key: "B", logger, subcommand: "set", value: "2" });

            await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "unset" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(file).not.toMatch(/^A=/mu);
            expect(file).toMatch(/^B=/mu);

            const second = await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "unset" });

            expect(second.code).toBe(0);
            expect(recorded.warnings.join("\n")).toContain("A");
        });

        it("unset actually removes an export-prefixed line it reports as unset", async () => {
            expect.assertions(3);

            // The reader accepts `export KEY=…` (wrangler does), so `unset` must
            // edit that line too. When the writers matched a narrower grammar
            // this reported success while leaving the secret in the file — a
            // developer revoking a leaked credential was told it was gone.
            writeFileSync(join(workdir, ".dev.vars"), "# keep me\nexport AUTH_SECRET=leaked\nB=2\n", "utf8");

            const { logger, recorded } = recordingLogger();

            const result = await runEnvCommand({ cwd: workdir, key: "AUTH_SECRET", logger, subcommand: "unset" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(result.code).toBe(0);
            expect(file).not.toContain("leaked");
            expect(recorded.warnings.join("\n")).not.toContain("AUTH_SECRET");
        });

        it("unset still warns for a key that is genuinely absent", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, ".dev.vars"), "# AUTH_SECRET=commented\nB=2\n", "utf8");

            const { logger, recorded } = recordingLogger();

            const result = await runEnvCommand({ cwd: workdir, key: "AUTH_SECRET", logger, subcommand: "unset" });

            expect(result.code).toBe(0);
            expect(recorded.warnings.join("\n")).toContain("was not set");
        });

        it("unset rejects an invalid key rather than building an unescaped regex from it", async () => {
            expect.assertions(2);

            const { logger, recorded } = recordingLogger();

            const result = await runEnvCommand({ cwd: workdir, key: "A.B", logger, subcommand: "unset" });

            expect(result.code).toBe(1);
            expect(recorded.errors.join("\n")).toContain("invalid key");
        });

        it("unset removes only the exact key, not a lookalike sharing its prefix", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, ".dev.vars"), "FOO=1\nFOO_BAR=2\n", "utf8");

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, key: "FOO", logger, subcommand: "unset" });

            const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(file).not.toMatch(/^FOO=/mu);
            expect(file).toContain("FOO_BAR=2");
            expect(file.split("\n").filter((line) => line.startsWith("FOO_BAR="))).toHaveLength(1);
        });

        it("push refuses to upload a placeholder value, naming the offending key and nothing gets spawned", async () => {
            expect.assertions(4);

            const { logger, recorded } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), 'REAL_KEY="a-real-value"\nAUTH_SECRET="replace-me"\n', "utf8");

            const { calls, spawner } = createRecordingSpawner();

            const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(recorded.errors.join("\n")).toContain("AUTH_SECRET");
            expect(recorded.errors.join("\n")).toContain("env doctor");
        });

        it("push proceeds when every value is real (no placeholder regression)", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), 'REAL_KEY="a-real-value"\nOTHER_KEY="also-real"\n', "utf8");

            const { calls, spawner } = createRecordingSpawner();

            const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(2);
        });

        it("push without --yes is refused", async () => {
            expect.assertions(3);

            const { logger, recorded } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "SECRET=value\n", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push" });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(recorded.errors.join("\n")).toContain("--yes");
        });

        it("push with --yes invokes wrangler secret put per key (sequentially, value via env)", async () => {
            expect.assertions(7);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "FIRST=one\nSECOND=two\n", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(2);
            // The value is piped into stdin, never in argv or env.
            expect(calls[0]?.descriptor.args.join(" ")).toBe("exec wrangler secret put FIRST");
            expect(calls[1]?.descriptor.args.join(" ")).toBe("exec wrangler secret put SECOND");
            expect(calls[0]?.descriptor.input).toBe("one");
            expect(calls[1]?.descriptor.input).toBe("two");
            // Sanity: no env leak.
            expect(calls[0]?.descriptor.env).toBeUndefined();
        });

        it("launches wrangler through npx when the project declares npm (secret stays on stdin)", async () => {
            expect.assertions(4);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "FIRST=one\n", "utf8");
            // `detectPackageManager` reads the nearest package.json's `packageManager`.
            writeFileSync(join(workdir, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");

            const { calls, spawner } = createRecordingSpawner();

            await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

            expect(calls[0]?.descriptor.command).toBe("npx");
            expect(calls[0]?.descriptor.args).toStrictEqual(["--", "wrangler", "secret", "put", "FIRST"]);
            // The value still travels over stdin, never on argv.
            expect(calls[0]?.descriptor.input).toBe("one");
            expect(calls[0]?.descriptor.args).not.toContain("one");
        });

        it("push --prod adds --env production", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "OK=1\n", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            await runEnvCommand({ cwd: workdir, logger, prod: true, spawner, subcommand: "push", yes: true });

            expect(calls[0]?.descriptor.args).toContain("--env");
            expect(calls[0]?.descriptor.args).toContain("production");
        });

        it("push --env staging adds --env staging", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "OK=1\n", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            await runEnvCommand({ cwd: workdir, env: "staging", logger, spawner, subcommand: "push", yes: true });

            expect(calls[0]?.descriptor.args).toContain("--env");
            expect(calls[0]?.descriptor.args).toContain("staging");
        });

        it("push --env wins over --prod when both are set", async () => {
            expect.assertions(1);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "OK=1\n", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            await runEnvCommand({ cwd: workdir, env: "staging", logger, prod: true, spawner, subcommand: "push", yes: true });

            expect(calls[0]?.descriptor.args).toContain("staging");
        });

        it("push --temporary adds --temporary to each secret put", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "FIRST=1\nSECOND=2\n", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", temporary: true, yes: true });

            expect(calls[0]?.descriptor.args).toContain("--temporary");
            expect(calls[1]?.descriptor.args).toContain("--temporary");
        });

        it("push aborts immediately on first wrangler failure", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();

            writeFileSync(join(workdir, ".dev.vars"), "A=1\nB=2\nC=3\n", "utf8");

            const { calls, spawner } = createRecordingSpawner(2);

            const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

            expect(result.code).toBe(2);
            // Sequential: must have stopped after the first failure.
            expect(calls).toHaveLength(1);
        });

        it("set rejects invalid keys (cannot start with digit)", async () => {
            expect.assertions(3);

            const { logger, recorded } = recordingLogger();

            const result = await runEnvCommand({ cwd: workdir, key: "1BAD", logger, subcommand: "set", value: "x" });

            expect(result.code).toBe(1);
            expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
            expect(recorded.errors.join("\n")).toContain("invalid key");
        });
    });

    describe("lunora env doctor", () => {
        it("passes when .dev.vars covers the example with real values", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, ".dev.vars.example"), 'AUTH_SECRET="replace-me"\nAUTH_URL="x"\n', "utf8");
            writeFileSync(join(workdir, ".dev.vars"), 'AUTH_SECRET="a-real-secret-value"\nAUTH_URL="http://localhost:5173"\n', "utf8");

            const { logger, recorded } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, subcommand: "doctor" });

            expect(result.code).toBe(0);
            expect(recorded.successes.join("\n")).toContain("looks good");
        });

        it("flags missing keys and unset placeholder values, exiting non-zero", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, ".dev.vars.example"), 'AUTH_SECRET="replace-me"\nAUTH_URL="x"\n', "utf8");
            // AUTH_URL missing entirely; AUTH_SECRET present but still a placeholder.
            writeFileSync(join(workdir, ".dev.vars"), 'AUTH_SECRET="replace-me"\n', "utf8");

            const { logger, recorded } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, subcommand: "doctor" });

            expect(result.code).toBe(1);
            expect(recorded.errors.join("\n")).toContain("AUTH_URL");
            expect(recorded.errors.join("\n")).toContain("placeholder");
        });

        it("errors when .dev.vars is missing but an example exists", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, ".dev.vars.example"), 'AUTH_SECRET="replace-me"\n', "utf8");

            const { logger, recorded } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, subcommand: "doctor" });

            expect(result.code).toBe(1);
            expect(recorded.errors.join("\n")).toContain("is missing");
        });

        it("stays quiet (exit 0) when there is no example to check against", async () => {
            expect.assertions(1);

            const { logger } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, subcommand: "doctor" });

            expect(result.code).toBe(0);
        });
    });

    describe("diff", () => {
        const stubLister =
            (names: string[], ok = true) =>
            async () => {
                return { names, ok, error: ok ? undefined : "boom" };
            };

        it("diff surfaces a wrangler failure as exit 1", async () => {
            expect.assertions(1);

            const { logger } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, secretLister: stubLister([], false), subcommand: "diff" });

            expect(result.code).toBe(1);
        });

        it("diff --env staging targets staging rather than production", async () => {
            expect.assertions(1);

            let seenEnv: string | undefined;
            const lister = async (inputs: { env?: string }): Promise<{ names: string[]; ok: boolean }> => {
                seenEnv = inputs.env;

                return { names: [], ok: true };
            };

            const { logger } = recordingLogger();

            await runEnvCommand({ cwd: workdir, env: "staging", logger, secretLister: lister, subcommand: "diff" });

            expect(seenEnv).toBe("staging");
        });

        it("diff reports local-only and remote-only keys", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, ".dev.vars"), 'SHARED="x"\nLOCAL_ONLY="y"\n', "utf8");

            const { logger, recorded } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, secretLister: stubLister(["SHARED", "REMOTE_ONLY"]), subcommand: "diff" });

            expect(result.code).toBe(0);

            const infos = recorded.infos.join("\n");

            expect(infos).toContain("LOCAL_ONLY");
            expect(infos).toContain("REMOTE_ONLY");
        });
    });

    describe("lunora env generate", () => {
        const HEX64 = /^[a-f0-9]{64}$/u;

        it.skipIf(process.platform === "win32")("writes .dev.vars owner-only (mode 0o600) when --set creates it fresh — regression for plan 317", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, key: "AUTH_SECRET", logger, set: true, subcommand: "generate" });

            expect(result.code).toBe(0);
            // eslint-disable-next-line no-bitwise -- checking the permission bits is the point of this test
            expect(statSync(join(workdir, ".dev.vars")).mode & 0o777).toBe(0o600);
        });

        it("writes generated values for the project's mintable secrets with --set (skipping provider keys)", async () => {
            expect.assertions(5);

            // A feature-scaffolded .dev.vars: two mintable secrets + a provider key, all blank.
            writeFileSync(join(workdir, ".dev.vars"), "BETTER_AUTH_SECRET=\nSTORAGE_SIGNING_SECRET=\nRESEND_API_KEY=\n", "utf8");

            const { logger } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, set: true, subcommand: "generate" });

            expect(result.code).toBe(0);

            const map = new Map(
                readFileSync(join(workdir, ".dev.vars"), "utf8")
                    .split("\n")
                    .filter((line) => line.includes("="))
                    .map((line) => {
                        const eq = line.indexOf("=");

                        return [line.slice(0, eq), line.slice(eq + 1).replaceAll(/^"|"$/gu, "")] as const;
                    }),
            );

            // Mintable secrets filled with strong hex; the core admin token is added.
            expect(map.get("BETTER_AUTH_SECRET")).toMatch(HEX64);
            expect(map.get("STORAGE_SIGNING_SECRET")).toMatch(HEX64);
            expect(map.get("LUNORA_ADMIN_TOKEN")).toMatch(HEX64);
            // The provider key (Resend) is NOT minted — you obtain it from a dashboard.
            expect(map.get("RESEND_API_KEY")).toBe("");
        });

        it("--set leaves live secrets alone and mints only the blank/placeholder ones", async () => {
            expect.assertions(4);

            const live = "a".repeat(64);

            // STORAGE_SIGNING_SECRET already holds a real value: rotating it
            // invalidates every signed URL outstanding, unrecoverably.
            writeFileSync(join(workdir, ".dev.vars"), `BETTER_AUTH_SECRET=\nSTORAGE_SIGNING_SECRET=${live}\n`, "utf8");

            const { logger, recorded } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, logger, set: true, subcommand: "generate" });
            const written = readFileSync(join(workdir, ".dev.vars"), "utf8");

            expect(result.code).toBe(0);
            expect(written).toContain(`STORAGE_SIGNING_SECRET=${live}`);
            expect(written).toMatch(/BETTER_AUTH_SECRET="?[a-f0-9]{64}/u);
            expect(recorded.warnings.join("\n")).toContain("STORAGE_SIGNING_SECRET");
        });

        it("--set on an explicit key that already holds a live secret refuses without --yes", async () => {
            expect.assertions(4);

            const live = "b".repeat(64);

            writeFileSync(join(workdir, ".dev.vars"), `LUNORA_ADMIN_TOKEN=${live}\n`, "utf8");

            const { logger, recorded } = recordingLogger();
            const refused = await runEnvCommand({ cwd: workdir, key: "LUNORA_ADMIN_TOKEN", logger, set: true, subcommand: "generate" });

            expect(refused.code).toBe(1);
            expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).toContain(live);

            // …and --yes is the deliberate rotation.
            await runEnvCommand({ cwd: workdir, key: "LUNORA_ADMIN_TOKEN", logger, set: true, subcommand: "generate", yes: true });

            expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).not.toContain(live);
            expect(recorded.errors.join("\n")).toContain("--yes");
        });

        it("prints KEY=value to stdout for an explicit key (default, no --set)", async () => {
            expect.assertions(3);

            const writes: string[] = [];
            const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
                writes.push(String(chunk));

                return true;
            });

            const { logger } = recordingLogger();

            try {
                const result = await runEnvCommand({ cwd: workdir, key: "AUTH_SECRET", logger, subcommand: "generate" });

                expect(result.code).toBe(0);
            } finally {
                spy.mockRestore();
            }

            const printed = writes.join("");

            expect(printed).toMatch(/^AUTH_SECRET=[a-f0-9]{64}\n$/u);
            // Default mode never touches .dev.vars.
            expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
        });

        it("rejects an invalid explicit key", async () => {
            expect.assertions(2);

            const { logger, recorded } = recordingLogger();
            const result = await runEnvCommand({ cwd: workdir, key: "bad-key!", logger, subcommand: "generate" });

            expect(result.code).toBe(1);
            expect(recorded.errors.join("\n")).toContain("invalid key");
        });
    });
});
