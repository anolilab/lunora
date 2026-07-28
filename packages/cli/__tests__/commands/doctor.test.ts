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
});
