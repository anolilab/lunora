import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProjectConfigLiterals, readProjectStudioCompanion } from "../src/project-config-file";
import { runCodegen } from "../src/run-codegen";

describe("studio.companion in lunora.config", () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-companion-config-"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    const writeConfig = (body: string): void => {
        writeFileSync(join(projectRoot, "lunora.config.ts"), `export default ${body};\n`, "utf8");
    };

    it.each([
        ["{ studio: { companion: true } }", { companion: true }],
        ["{ studio: { companion: false } }", { companion: false }],
        ["{ studio: {} }", {}],
        ["{ studio: { companion: process.env.C === '1' } }", { unreadable: true }],
        ["{ get studio() { return { companion: true }; } }", { unreadable: true }],
    ])("reads %s", (body, expected) => {
        expect.assertions(1);

        writeConfig(body);

        expect(readProjectConfigLiterals(projectRoot).studio).toStrictEqual(expected);
    });

    it("reads no studio key when the config does not declare one", () => {
        expect.assertions(2);

        writeConfig("{ target: 'cloudflare' }");

        expect(readProjectConfigLiterals(projectRoot).studio).toBeUndefined();
        expect(readProjectStudioCompanion(join(projectRoot, "lunora"))).toBe(false);
    });

    it("treats an unreadable value as off and says so", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeConfig("{ studio: { companion: process.env.C === '1' } }");

        expect(readProjectStudioCompanion(join(projectRoot, "lunora"))).toBe(false);

        // Codegen and each binding read call this; one warning per config file is enough.
        readProjectStudioCompanion(join(projectRoot, "lunora"));

        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe("the generated companion Worker", () => {
    let projectRoot: string;
    let companion: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-companion-gen-"));
        companion = join(projectRoot, "lunora", "_generated", "companion");
        cpSync(join(import.meta.dirname, "fixtures", "simple", "lunora"), join(projectRoot, "lunora"), { recursive: true });
        writeFileSync(join(projectRoot, "wrangler.jsonc"), '{ // main\n "name": "my-app", "compatibility_date": "2025-01-01" }\n', "utf8");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    const enable = (): void => {
        writeFileSync(join(projectRoot, "lunora.config.ts"), "export default { studio: { companion: true } };\n", "utf8");
    };

    it("turns observability on for the companion, or copies the app's settings when it has them", () => {
        expect.assertions(2);

        enable();
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        expect(JSON.parse(readFileSync(join(companion, "wrangler.jsonc"), "utf8"))).toMatchObject({ observability: { enabled: true } });

        writeFileSync(
            join(projectRoot, "wrangler.jsonc"),
            '{ "name": "my-app", "compatibility_date": "2025-01-01", "observability": { "enabled": true, "head_sampling_rate": 0.2 } }\n',
            "utf8",
        );
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        expect(JSON.parse(readFileSync(join(companion, "wrangler.jsonc"), "utf8"))).toMatchObject({
            observability: { enabled: true, head_sampling_rate: 0.2 },
        });
    });

    it("writes the wrangler config, the self-contained worker and the payload when on, and removes them when off", () => {
        expect.assertions(13);

        enable();
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        const wrangler: unknown = JSON.parse(readFileSync(join(companion, "wrangler.jsonc"), "utf8"));
        const worker = readFileSync(join(companion, "src", "worker.ts"), "utf8");
        const payload = readFileSync(join(companion, "advisor-procedures.json"), "utf8");

        expect(wrangler).toMatchObject({ compatibility_date: "2025-01-01", main: "src/worker.ts", name: "my-app-advisor" });
        expect(wrangler).not.toHaveProperty("bindings");
        expect(JSON.parse(payload)).toHaveProperty("procedures");
        expect(worker).toContain(JSON.stringify(payload));
        // The Worker has no admin check, so neither kind of public address may be left to wrangler's defaults.
        expect(wrangler).toMatchObject({ preview_urls: false, workers_dev: false });
        expect(worker).not.toContain("LUNORA_ADMIN_TOKEN");
        expect(worker).toContain("/__lunora/advisor-procedures");
        expect(worker).toContain("export default");
        expect(worker).not.toMatch(/^import /mu);
        expect(worker).not.toContain('from "@lunora');
        expect(worker).not.toContain('from "node:');

        writeFileSync(join(projectRoot, "lunora.config.ts"), "export default {};\n", "utf8");
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        expect(existsSync(companion)).toBe(false);

        enable();
        runCodegen({ projectRoot, wranglerQueueProducers: [] });
        writeFileSync(join(projectRoot, "lunora.config.ts"), "export default { studio: { companion: false } };\n", "utf8");
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        expect(existsSync(companion)).toBe(false);
    });

    it("marks the companion payload as disabled when the run skipped the analysis", () => {
        expect.assertions(3);

        enable();

        const result = runCodegen({ lint: false, projectRoot, wranglerQueueProducers: [] });

        const payload = readFileSync(join(companion, "advisor-procedures.json"), "utf8");
        const worker = readFileSync(join(companion, "src", "worker.ts"), "utf8");

        // A `{ procedures: [] }` payload would score as a deployment with nothing wrong; the marker keeps the
        // studio from presenting a skipped analysis as a clean one.
        expect(JSON.parse(payload)).toStrictEqual({ analysis: "disabled", procedures: [] });
        expect(result.generated.advisorProceduresJson).toBe(payload);
        expect(worker).toContain(JSON.stringify(payload));
    });

    it("leaves files other tools keep in the companion folder alone, on regeneration and when switched off", () => {
        expect.assertions(4);

        enable();
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        mkdirSync(join(companion, ".wrangler", "tmp"), { recursive: true });
        writeFileSync(join(companion, ".wrangler", "tmp", "bundle.js"), "x", "utf8");
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        expect(existsSync(join(companion, ".wrangler", "tmp", "bundle.js"))).toBe(true);

        writeFileSync(join(projectRoot, "lunora.config.ts"), "export default {};\n", "utf8");
        runCodegen({ projectRoot, wranglerQueueProducers: [] });

        expect(existsSync(join(companion, ".wrangler", "tmp", "bundle.js"))).toBe(true);
        expect(existsSync(join(companion, "wrangler.jsonc"))).toBe(false);
        expect(existsSync(join(companion, "src"))).toBe(false);
    });
});
