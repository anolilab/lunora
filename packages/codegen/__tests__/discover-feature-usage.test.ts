import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeatureUsage } from "../src/discover-feature-usage";
import { buildStudioFeatures, discoverFeatureUsage } from "../src/discover-feature-usage";

let workdir: string;

const ALL_OFF: FeatureUsage = { ai: false, mail: false, payments: false, scheduler: false, storage: false, vectors: false };

const NO_SIGNALS = { cronCount: 0, dependencies: new Set<string>(), storageColumnCount: 0, storageRuleCount: 0, vectorIndexCount: 0 };

describe("discover-feature-usage", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-feature-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeSource = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    it("reports every feature off when no source touches one", () => {
        expect.assertions(1);

        writeSource("messages.ts", `export const list = () => [];`);

        expect(discoverFeatureUsage(newProject(), workdir)).toStrictEqual(ALL_OFF);
    });

    it("flips a flag on an imported `@cirrus/*` package", () => {
        expect.assertions(1);

        writeSource("notify.ts", `import { sendMail } from "@cirrus/mail";\nexport const go = () => sendMail();`);

        expect(discoverFeatureUsage(newProject(), workdir)).toMatchObject({ mail: true });
    });

    it("detects ai and payments via the package import or the `ctx.*` helper", () => {
        expect.assertions(4);

        writeSource("ask.ts", `import { createAi } from "@cirrus/ai";\nexport const a = () => createAi();`);
        writeSource("bill.ts", `export const charge = async (ctx) => ctx.payments.checkout();`);

        const usage = discoverFeatureUsage(newProject(), workdir);

        expect(usage.ai).toBe(true);
        expect(usage.payments).toBe(true);

        // The reverse wiring (ai via ctx, payments via import) flips them too.
        rmSync(join(workdir, "ask.ts"));
        rmSync(join(workdir, "bill.ts"));
        writeSource("ask2.ts", `export const a = async (ctx) => ctx.ai.run("m", {});`);
        writeSource("bill2.ts", `import { stripe } from "@cirrus/payment";\nexport const c = () => stripe();`);

        const reverse = discoverFeatureUsage(newProject(), workdir);

        expect(reverse.ai).toBe(true);
        expect(reverse.payments).toBe(true);
    });

    it("flips a flag on a `ctx.*` helper read even without the package import", () => {
        expect.assertions(2);

        writeSource("upload.ts", `export const put = async (ctx) => ctx.storage.put("k", new Blob());`);
        writeSource("similar.ts", `export const search = async (ctx) => ctx.vectors.query("idx", []);`);

        const usage = discoverFeatureUsage(newProject(), workdir);

        expect(usage.storage).toBe(true);
        expect(usage.vectors).toBe(true);
    });

    it("detects a `ctx.*` helper reached through a `const { … } = ctx` destructuring", () => {
        expect.assertions(1);

        writeSource("upload.ts", `export const put = async (ctx) => {\n  const { storage } = ctx;\n  return storage.put("k", new Blob());\n};`);

        expect(discoverFeatureUsage(newProject(), workdir).storage).toBe(true);
    });

    it("detects scheduler via either the package import or `ctx.scheduler`", () => {
        expect.assertions(2);

        writeSource("a.ts", `import { cronJobs } from "@cirrus/scheduler";\nexport const c = cronJobs();`);
        const viaImport = discoverFeatureUsage(newProject(), workdir);

        rmSync(join(workdir, "a.ts"));
        writeSource("b.ts", `export const after = async (ctx) => ctx.scheduler.runAfter(1000, "x");`);
        const viaContext = discoverFeatureUsage(newProject(), workdir);

        expect(viaImport.scheduler).toBe(true);
        expect(viaContext.scheduler).toBe(true);
    });

    it("does not flag mail on an unrelated `mail` property read (import-only feature)", () => {
        expect.assertions(1);

        // `ctx.mail` is not a real helper — mail is reached via its own client, so
        // only a `@cirrus/mail` import should ever flip the flag.
        writeSource("u.ts", `export const f = (user) => user.mail;`);

        expect(discoverFeatureUsage(newProject(), workdir).mail).toBe(false);
    });

    describe("buildStudioFeatures", () => {
        it("hides every page when nothing uses a feature and no signal fires", () => {
            expect.assertions(1);

            expect(buildStudioFeatures(ALL_OFF, NO_SIGNALS)).toStrictEqual({
                mail: false,
                payments: false,
                scheduler: false,
                storage: false,
                vectors: false,
            });
        });

        it("shows a page when its code-usage flag is set", () => {
            expect.assertions(1);

            expect(buildStudioFeatures({ ...ALL_OFF, storage: true, vectors: true }, NO_SIGNALS)).toMatchObject({ storage: true, vectors: true });
        });

        it("shows a page from its schema/project signal even with no code usage", () => {
            expect.assertions(4);

            const result = buildStudioFeatures(ALL_OFF, {
                cronCount: 1,
                dependencies: new Set<string>(),
                storageColumnCount: 2,
                storageRuleCount: 0,
                vectorIndexCount: 3,
            });

            expect(result.scheduler).toBe(true);
            expect(result.storage).toBe(true);
            expect(result.vectors).toBe(true);
            // mail has no schema signal — it stays hidden until usage or a dependency fires.
            expect(result.mail).toBe(false);
        });

        it("shows a package-backed page when the package is a declared dependency (worker-entry wiring)", () => {
            expect.assertions(1);

            // This is the mail fix: mail is wired in the worker entry, not under `cirrus/`,
            // so only the declared dependency keeps its page shown.
            const result = buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@cirrus/mail", "@cirrus/payment"]) });

            expect(result).toMatchObject({ mail: true, payments: true });
        });
    });
});
