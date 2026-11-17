import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
