import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/commands/doctor/handler";
import type { Logger } from "../../src/util/logger";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

/** A clean wrangler.jsonc: SHARD DO binding + a real-looking D1 id. */
const CLEAN_WRANGLER = JSON.stringify(
    {
        compatibility_date: "2026-04-07",
        d1_databases: [{ binding: "DB", database_id: "11111111-2222-3333-4444-555555555555" }],
        durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
        name: "demo",
    },
    null,
    4,
);

/** Same, but the D1 id is a scaffold placeholder. */
const PLACEHOLDER_WRANGLER = JSON.stringify(
    {
        compatibility_date: "2026-04-07",
        d1_databases: [{ binding: "DB", database_id: "<replace-with-d1-create-id>" }],
        durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
        name: "demo",
    },
    null,
    4,
);

const seed = (dir: string, wrangler: string): void => {
    writeFileSync(join(dir, "wrangler.jsonc"), wrangler, "utf8");
};

let workdir: string;
let savedToken: string | undefined;

describe("runDoctor", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-doctor-"));
        savedToken = process.env.LUNORA_ADMIN_TOKEN;
        delete process.env.LUNORA_ADMIN_TOKEN;
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });

        if (savedToken === undefined) {
            delete process.env.LUNORA_ADMIN_TOKEN;
        } else {
            process.env.LUNORA_ADMIN_TOKEN = savedToken;
        }
    });

    it("reports a failure on a placeholder D1 database_id", async () => {
        expect.assertions(2);

        seed(workdir, PLACEHOLDER_WRANGLER);

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.code).toBe(1);
        expect(result.findings.some((finding) => finding.level === "fail" && /placeholder database_id/u.test(finding.message))).toBe(true);
    });

    it("passes on a clean project (only an INFO for the missing admin token)", async () => {
        expect.assertions(3);

        seed(workdir, CLEAN_WRANGLER);

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.code).toBe(0);
        expect(result.findings.some((finding) => finding.level === "fail")).toBe(false);
        expect(result.findings.some((finding) => finding.level === "warn")).toBe(false);
    });

    it("reports a failure when wrangler.jsonc is missing", async () => {
        expect.assertions(2);

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.code).toBe(1);
        expect(result.findings.some((finding) => finding.level === "fail" && /wrangler\.jsonc not found/u.test(finding.message))).toBe(true);
    });

    it("warns on unfilled .dev.vars secrets", async () => {
        expect.assertions(2);

        seed(workdir, CLEAN_WRANGLER);

        const secretKey = "AUTH_SECRET";
        const devVarsLines = [`${secretKey}=<replace-me>`, "PUBLIC_URL=http://localhost:8787", ""].join("\n");

        writeFileSync(join(workdir, ".dev.vars"), devVarsLines, "utf8");

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.code).toBe(0);
        expect(result.findings.some((finding) => finding.level === "warn" && /AUTH_SECRET/u.test(finding.message))).toBe(true);
    });

    const seedContainerProject = (entry: string): void => {
        seed(
            workdir,
            JSON.stringify({
                compatibility_date: "2026-04-07",
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                main: "src/server.ts",
                name: "demo",
            }),
        );
        mkdirSync(join(workdir, "src"), { recursive: true });
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "src", "server.ts"), entry, "utf8");
        writeFileSync(
            join(workdir, "lunora", "containers.ts"),
            'import { defineContainer } from "@lunora/container";\nexport const transcoder = defineContainer({ image: "./containers/transcoder" });\n',
            "utf8",
        );
    };

    it("fails when a declared container is not exported by the worker entry", async () => {
        expect.assertions(2);

        seedContainerProject('import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\n');

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.code).toBe(1);
        expect(result.findings.some((finding) => finding.level === "fail" && /container "transcoder" is declared but/u.test(finding.message))).toBe(true);
    });

    it("passes when the declared container is exported by the worker entry", async () => {
        expect.assertions(1);

        seedContainerProject(
            'import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\nexport * from "../lunora/_generated/containers.js";\n',
        );

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.findings.some((finding) => finding.level === "pass" && /container "transcoder" is exported/u.test(finding.message))).toBe(true);
    });
});
