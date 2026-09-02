import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DOCTOR_CODES, runDoctor, runDoctorCommand } from "../../src/commands/doctor/handler";
import type { Logger } from "../../src/util/logger";

/** Run async `body` while capturing everything written to `process.stdout`. */
const captureStdout = async (body: () => Promise<void>): Promise<string> => {
    let captured = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

        return true;
    });

    try {
        await body();
    } finally {
        spy.mockRestore();
    }

    return captured;
};

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

/** Write a `lunora/schema.ts` so the schema-derived checks have something to read. */
const seedSchema = (dir: string, source: string): void => {
    mkdirSync(join(dir, "lunora"), { recursive: true });
    writeFileSync(join(dir, "lunora", "schema.ts"), source, "utf8");
};

const SCHEMA_WITH_VECTOR_METADATA = `import { defineSchema, defineTable, v } from "@lunora/server";

const embed = async (text: string): Promise<number[]> => [text.length];

export const schema = defineSchema({
    docs: defineTable({
        body: v.string(),
        tags: v.array(v.string()),
        workspaceId: v.id("workspaces"),
    }).vectorize("body", { dimensions: 1024, embed, index: "docs-body", metadata: ["workspaceId", "tags"], metric: "cosine" }),
});
`;

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

    /**
     * The one check whose absence is invisible in production. Cloudflare only
     * filters on a Vectorize metadata property that has an explicit metadata
     * index; without one, `filter` matches nothing and returns an empty list
     * that reads exactly like "no documents matched". `lunora deploy` creates
     * them, so doctor's job is to name the command for anyone deploying with
     * wrangler directly — and to refuse to promise a filter that can never work.
     */
    it("names the exact command for each declared Vectorize metadata index", async () => {
        expect.assertions(2);

        seed(workdir, CLEAN_WRANGLER);
        seedSchema(workdir, SCHEMA_WITH_VECTOR_METADATA);

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });
        const finding = result.findings.find((entry) => entry.level === "info" && entry.message.includes(`metadata "workspaceId"`));

        expect(finding?.message).toContain(`vector index "docs-body"`);
        // Pasteable, with the type derived from the column — a metadata index
        // created with the wrong type never matches either.
        expect(finding?.fix).toBe("wrangler vectorize create-metadata-index docs-body --property-name=workspaceId --type=string");
    });

    it("warns about a metadata property whose type Vectorize cannot filter on", async () => {
        expect.assertions(2);

        seed(workdir, CLEAN_WRANGLER);
        seedSchema(workdir, SCHEMA_WITH_VECTOR_METADATA);

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });
        const finding = result.findings.find((entry) => entry.level === "warn" && entry.message.includes(`metadata "tags"`));

        // An array can be *stored* as metadata but never filtered on, so
        // creating an index for it would be a command that cannot help.
        expect(finding).toBeDefined();
        expect(finding?.message).toContain("cannot filter on");
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

    it("counts a .dev.vars LUNORA_ADMIN_TOKEN as set", async () => {
        expect.assertions(2);

        seed(workdir, CLEAN_WRANGLER);
        writeFileSync(join(workdir, ".dev.vars"), "LUNORA_ADMIN_TOKEN=dev-token\n", "utf8");

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.findings.some((finding) => finding.code === "admin-token-missing")).toBe(false);
        expect(result.findings.some((finding) => finding.code === "admin-token-set")).toBe(true);
    });

    it("reports the token as missing when neither the environment nor .dev.vars has one", async () => {
        expect.assertions(1);

        seed(workdir, CLEAN_WRANGLER);

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.findings.some((finding) => finding.code === "admin-token-missing")).toBe(true);
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

    /**
     * Workflows and agents fail exactly the way containers do — wrangler rejects a
     * `class_name` the worker doesn't export — but only containers were checked
     * here, so a project could pass `doctor` and still deploy a workflow with
     * nothing to run. That is the failure the reporter hit on deploy day.
     */
    const seedWorkflowProject = (entry: string): void => {
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
            join(workdir, "lunora", "workflows.ts"),
            'import { defineWorkflow } from "@lunora/workflow";\nexport const orderPipeline = defineWorkflow({ run: async () => undefined });\n',
            "utf8",
        );
    };

    it("fails when a declared workflow is not exported by the worker entry", async () => {
        expect.assertions(2);

        seedWorkflowProject('import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\n');

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.code).toBe(1);
        expect(result.findings.some((finding) => finding.level === "fail" && /workflow "orderPipeline" is declared but/u.test(finding.message))).toBe(true);
    });

    it("passes when the declared workflow is exported by the worker entry", async () => {
        expect.assertions(1);

        seedWorkflowProject(
            'import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\nexport * from "../lunora/_generated/workflows.js";\n',
        );

        const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

        expect(result.findings.some((finding) => finding.level === "pass" && /workflow "orderPipeline" is exported/u.test(finding.message))).toBe(true);
    });

    /**
     * Nothing in an app's manifest tells the adopter which combination of the
     * independently-versioned `@lunora/*` packages is coherent, so a partial
     * `pnpm update` produces a set that looks fine and behaves like a framework bug.
     */
    describe("version skew", () => {
        const seedManifest = (dependencies: Record<string, string>): void => {
            seed(workdir, CLEAN_WRANGLER);
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies, name: "demo" }), "utf8");
        };

        const versionFinding = (findings: ReadonlyArray<{ level: string; message: string }>) => findings.find((finding) => /Lunora p/u.test(finding.message));

        it("warns when Lunora packages span different versions", async () => {
            expect.assertions(3);

            seedManifest({ "@lunora/db": "1.0.0-alpha.27", "@lunora/react": "1.1.0-alpha.4", lunorash: "1.0.0-alpha.98" });

            const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });
            const finding = versionFinding(result.findings);

            expect(finding?.level).toBe("warn");
            expect(finding?.message).toContain("@lunora/react@1.1.0-alpha.4");
            // A warning, never a failure: the doctor doesn't know the real
            // compatibility matrix and must not block a deliberate mix.
            expect(result.code).toBe(0);
        });

        it("warns when packages mix release channels", async () => {
            expect.assertions(2);

            seedManifest({ "@lunora/db": "1.0.0", "@lunora/react": "1.0.0-alpha.31" });

            const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });
            const finding = versionFinding(result.findings);

            expect(finding?.level).toBe("warn");
            expect(finding?.message).toContain("mix release channels");
        });

        it("reports same-channel counter drift as info, since independent versioning makes it normal", async () => {
            expect.assertions(2);

            seedManifest({ "@lunora/db": "1.0.0-alpha.27", "@lunora/react": "1.0.0-alpha.31", lunorash: "1.0.0-alpha.98" });

            const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });
            const finding = versionFinding(result.findings);

            expect(finding?.level).toBe("info");
            expect(finding?.message).toContain("27–98");
        });

        it("ignores non-Lunora dependencies and unpinnable specs", async () => {
            expect.assertions(1);

            seedManifest({ "@lunora/db": "workspace:*", "@lunora/react": "1.0.0-alpha.31", react: "^19.0.0" });

            const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

            // Only one pinnable Lunora spec remains, so there is nothing to compare.
            expect(versionFinding(result.findings)).toBeUndefined();
        });

        it("skips silently when there is no package.json", async () => {
            expect.assertions(1);

            seed(workdir, CLEAN_WRANGLER);

            const result = await runDoctor({ cwd: workdir, logger: makeLogger().logger });

            expect(versionFinding(result.findings)).toBeUndefined();
        });
    });

    /**
     * A globally-installed `lunora` shadowing the project's pinned one makes every
     * other finding describe a project this CLI may be the wrong version for —
     * and `checkVersionSkew` cannot see it, because the manifest it reads is
     * exactly the file the shadowing binary ignores.
     */
    describe("cli shadowing", () => {
        /** Install `@lunora/cli` the way pnpm does: a symlink into a store directory. */
        const seedLocalCli = (): string => {
            const store = join(workdir, "node_modules", ".pnpm", "@lunora+cli@1.0.0", "node_modules", "@lunora", "cli", "dist");

            mkdirSync(store, { recursive: true });
            writeFileSync(join(store, "bin.mjs"), "// bin\n", "utf8");
            mkdirSync(join(workdir, "node_modules", "@lunora"), { recursive: true });
            symlinkSync(dirname(store), join(workdir, "node_modules", "@lunora", "cli"), "dir");

            return join(store, "bin.mjs");
        };

        const shadowFinding = (findings: ReadonlyArray<{ code: string; level: string }>) => findings.find((finding) => finding.code === "cli-shadowed");

        it("stays clean when the running binary is the project's own pnpm-linked install", async () => {
            expect.assertions(1);

            seed(workdir, CLEAN_WRANGLER);

            const localEntry = seedLocalCli();
            const result = await runDoctor({ cwd: workdir, executablePath: localEntry, logger: makeLogger().logger });

            // The bin is reached through a symlinked package directory, which is
            // the layout that a naive path-equality check reports as a mismatch.
            expect(shadowFinding(result.findings)).toBeUndefined();
        });

        it("warns exactly once when the running binary lives outside the project", async () => {
            expect.assertions(3);

            seed(workdir, CLEAN_WRANGLER);
            seedLocalCli();

            const globalDir = mkdtempSync(join(tmpdir(), "lunora-cli-global-"));
            const globalEntry = join(globalDir, "bin.mjs");

            writeFileSync(globalEntry, "// bin\n", "utf8");

            const result = await runDoctor({ cwd: workdir, executablePath: globalEntry, logger: makeLogger().logger });

            rmSync(globalDir, { force: true, recursive: true });

            expect(result.findings.filter((finding) => finding.code === "cli-shadowed")).toHaveLength(1);
            expect(shadowFinding(result.findings)?.level).toBe("warn");
            // A wrong binary is never a hard failure — it is often deliberate.
            expect(result.code).toBe(0);
        });

        it("skips silently when the project has no local install", async () => {
            expect.assertions(1);

            seed(workdir, CLEAN_WRANGLER);

            const result = await runDoctor({ cwd: workdir, executablePath: join(tmpdir(), "somewhere", "bin.mjs"), logger: makeLogger().logger });

            expect(shadowFinding(result.findings)).toBeUndefined();
        });
    });

    describe("--format json", () => {
        it("puts one JSON document on stdout and the human report on stderr", async () => {
            expect.assertions(5);

            seed(workdir, PLACEHOLDER_WRANGLER);

            const { logger } = makeLogger();
            let stderr = "";
            const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
                stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

                return true;
            });

            const stdout = await captureStdout(async () => {
                await runDoctorCommand({ cwd: workdir, format: "json", logger });
            });

            stderrSpy.mockRestore();

            const parsed = JSON.parse(stdout) as { code: number; findings: { code: string; level: string }[]; ok: boolean; summary: Record<string, number> };

            expect(parsed.ok).toBe(false);
            expect(parsed.code).toBe(1);
            expect(parsed.findings.some((finding) => finding.code === "d1-placeholder-id" && finding.level === "fail")).toBe(true);
            expect(parsed.summary.fail).toBe(1);
            // The report is still rendered — on stderr, so stdout stays pipeable.
            expect(stderr).toContain("lunora doctor — project preflight");
        });

        it("counts every level in the summary and keeps pass findings in the document", async () => {
            expect.assertions(2);

            seed(workdir, CLEAN_WRANGLER);

            const stdout = await captureStdout(async () => {
                await runDoctorCommand({ cwd: workdir, format: "json", logger: makeLogger().logger });
            });

            const parsed = JSON.parse(stdout) as { findings: { level: string }[]; summary: Record<"fail" | "info" | "pass" | "warn", number> };

            expect(parsed.summary.pass).toBeGreaterThan(0);
            expect(parsed.findings.filter((finding) => finding.level === "pass")).toHaveLength(parsed.summary.pass);
        });

        it("renders the human report on the caller's logger in pretty mode", async () => {
            expect.assertions(2);

            seed(workdir, CLEAN_WRANGLER);

            const { lines, logger } = makeLogger();

            const stdout = await captureStdout(async () => {
                await runDoctorCommand({ cwd: workdir, logger });
            });

            expect(stdout).toBe("");
            expect(lines.some((line) => line.includes("lunora doctor — project preflight"))).toBe(true);
        });

        it("rejects an unknown --format the same way the other commands do", async () => {
            expect.assertions(3);

            seed(workdir, CLEAN_WRANGLER);

            const { lines, logger } = makeLogger();

            const stdout = await captureStdout(async () => {
                const result = await runDoctorCommand({ cwd: workdir, format: "yaml", logger });

                expect(result.code).toBe(1);
            });

            expect(stdout).toBe("");
            expect(lines.some((line) => line.includes('unknown --format "yaml" — expected pretty | json'))).toBe(true);
        });
    });

    /**
     * The codes are the machine-readable contract, so adding or renaming one has
     * to be a deliberate act rather than a side effect of editing a check. The
     * docs table is the committed fixture: it is the artefact consumers read, so
     * asserting against it keeps the contract and its documentation in one place
     * instead of two that can drift.
     */
    describe("finding codes", () => {
        const DOCS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "index.mdx");

        it("is a sorted, duplicate-free list", () => {
            expect.assertions(2);

            expect([...DOCTOR_CODES]).toStrictEqual([...DOCTOR_CODES].toSorted((left, right) => left.localeCompare(right)));
            expect(new Set(DOCTOR_CODES).size).toBe(DOCTOR_CODES.length);
        });

        it("documents exactly the codes the doctor can emit", () => {
            expect.assertions(1);

            const documented = [...readFileSync(DOCS_PATH, "utf8").matchAll(/^\| `(?<code>[a-z\d-]+)` +\| +(?:fail|info|pass|warn) /gmu)].map(
                (match) => match.groups?.code ?? "",
            );

            expect(documented).toStrictEqual([...DOCTOR_CODES]);
        });
    });
});
