import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "worker-secrets.sh");

describe("worker-secrets.sh", () => {
    let sandbox: string | undefined;

    afterEach(() => {
        if (sandbox !== undefined) {
            rmSync(sandbox, { force: true, recursive: true });
            sandbox = undefined;
        }
    });

    it("writes the named secrets, drops empty ones, and never puts a value on jq's command line", () => {
        sandbox = mkdtempSync(join(tmpdir(), "worker-secrets-"));

        const realJq = execFileSync("/bin/bash", ["-c", "command -v jq"], { encoding: "utf8" }).trim();
        const argvLog = join(sandbox, "argv");
        const out = join(sandbox, "secrets.json");

        // A jq shim on PATH that records its argv — what a process listing would show — then runs the real one.
        writeFileSync(join(sandbox, "jq"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${argvLog}"\nexec "${realJq}" "$@"\n`);
        chmodSync(join(sandbox, "jq"), 0o755);

        execFileSync("/bin/bash", [SCRIPT, out, "AUTH_SECRET=SOURCE_AUTH", "WEBHOOK=SOURCE_WEBHOOK", "UNSET=SOURCE_UNSET"], {
            env: {
                ...process.env,
                PATH: `${sandbox}:${process.env["PATH"] ?? ""}`,
                SOURCE_AUTH: "s3cr3t-auth",
                SOURCE_UNSET: "",
                SOURCE_WEBHOOK: "s3cr3t=hook",
            },
        });

        expect(JSON.parse(readFileSync(out, "utf8"))).toStrictEqual({ AUTH_SECRET: "s3cr3t-auth", WEBHOOK: "s3cr3t=hook" });
        expect(readFileSync(argvLog, "utf8")).not.toContain("s3cr3t");
    });

    it("fails, naming every empty required secret and writing no file, when a `!` pair's source is empty", () => {
        sandbox = mkdtempSync(join(tmpdir(), "worker-secrets-"));

        const out = join(sandbox, "secrets.json");
        const run = (): string =>
            execFileSync("/bin/bash", [SCRIPT, out, "!AUTH_SECRET=SOURCE_AUTH", "!TOKEN=SOURCE_TOKEN", "OPTIONAL=SOURCE_OPTIONAL"], {
                encoding: "utf8",
                env: { ...process.env, SOURCE_AUTH: "", SOURCE_OPTIONAL: "" },
                stdio: "pipe",
            });

        expect(run).toThrow(/required secret is empty or unset: AUTH_SECRET \(from SOURCE_AUTH\)\n.*TOKEN \(from SOURCE_TOKEN\)/su);
        expect(existsSync(out)).toBe(false);
    });

    it("writes a required secret whose source is set, under its name without the `!`", () => {
        sandbox = mkdtempSync(join(tmpdir(), "worker-secrets-"));

        const out = join(sandbox, "secrets.json");

        execFileSync("/bin/bash", [SCRIPT, out, "!AUTH_SECRET=SOURCE_AUTH", "OPTIONAL=SOURCE_OPTIONAL"], {
            env: { ...process.env, SOURCE_AUTH: "s3cr3t", SOURCE_OPTIONAL: "" },
        });

        expect(JSON.parse(readFileSync(out, "utf8"))).toStrictEqual({ AUTH_SECRET: "s3cr3t" });
    });
});
