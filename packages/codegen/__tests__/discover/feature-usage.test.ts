import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeatureUsage } from "../../src/discover/feature-usage";
import { discoverFeatureUsage } from "../../src/discover/feature-usage";
import hasPaymentStoreTables from "../../src/discover/payment-store-tables";
import { buildStudioFeatures } from "../../src/discover/studio-features";
import type { TableIR } from "../../src/ir";

let workdir: string;

const ALL_OFF: FeatureUsage = {
    access: false,
    ai: false,
    analytics: false,
    browser: false,
    container: false,
    flags: false,
    hyperdrive: false,
    images: false,
    kv: false,
    mail: false,
    notify: false,
    payments: false,
    pipelines: false,
    r2sql: false,
    scheduler: false,
    storage: false,
    vectors: false,
    workflows: false,
    x402: false,
};

const NO_SIGNALS = {
    containerCount: 0,
    cronCount: 0,
    dependencies: new Set<string>(),
    hasPaymentTables: false,
    queueCount: 0,
    storageColumnCount: 0,
    storageRuleCount: 0,
    vectorIndexCount: 0,
    // The gate's verdict, not a signal the app raises: `true` is the
    // no-platform-objection baseline every case below is written against.
    vectorStoreSupported: true,
    workflowCount: 0,
};

describe("discover/feature-usage", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-feature-disco-"));
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

    it("flips a flag on an imported `@lunora/*` package", () => {
        expect.assertions(1);

        writeSource("notify.ts", `import { sendMail } from "@lunora/mail";\nexport const go = () => sendMail();`);

        expect(discoverFeatureUsage(newProject(), workdir)).toMatchObject({ mail: true });
    });

    it("detects ai and payments via the package import or the `ctx.*` helper", () => {
        expect.assertions(4);

        writeSource("ask.ts", `import { createAi } from "@lunora/ai";\nexport const a = () => createAi();`);
        writeSource("bill.ts", `export const charge = async (ctx) => ctx.payments.checkout();`);

        const usage = discoverFeatureUsage(newProject(), workdir);

        expect(usage.ai).toBe(true);
        expect(usage.payments).toBe(true);

        // The reverse wiring (ai via ctx, payments via import) flips them too.
        rmSync(join(workdir, "ask.ts"));
        rmSync(join(workdir, "bill.ts"));
        writeSource("ask2.ts", `export const a = async (ctx) => ctx.ai.run("m", {});`);
        writeSource("bill2.ts", `import { stripe } from "@lunora/payment";\nexport const c = () => stripe();`);

        const reverse = discoverFeatureUsage(newProject(), workdir);

        expect(reverse.ai).toBe(true);
        expect(reverse.payments).toBe(true);
    });

    it("detects the x402 pay rail via the `@lunora/x402/pay` import or a `ctx.x402` read", () => {
        expect.assertions(2);

        // The pay rail is an opt-in add-on subpath, so the exact `@lunora/x402/pay`
        // specifier flips it (the charge rail lives on `/charge` and does not wire ctx).
        writeSource("buy.ts", `import { createX402Pay } from "@lunora/x402/pay";\nexport const p = () => createX402Pay({}, {});`);
        const viaImport = discoverFeatureUsage(newProject(), workdir);

        rmSync(join(workdir, "buy.ts"));
        writeSource("pay.ts", `export const fetchPaid = async (ctx) => ctx.x402.fetch("https://api.example/paid");`);
        const viaContext = discoverFeatureUsage(newProject(), workdir);

        expect(viaImport.x402).toBe(true);
        expect(viaContext.x402).toBe(true);
    });

    it("detects notify via the `@lunora/notify` import (the `lunora/notify.ts` config) or a `ctx.notify` read", () => {
        expect.assertions(2);

        // The realistic signal is the app's `lunora/notify.ts` config — it imports
        // `defineNotify`, and the file is part of the scanned source set.
        writeSource("notify.ts", `import { defineNotify } from "@lunora/notify";\nexport default defineNotify({});`);
        const viaImport = discoverFeatureUsage(newProject(), workdir);

        rmSync(join(workdir, "notify.ts"));
        writeSource("ping.ts", `export const p = async (ctx) => ctx.notify.send({});`);
        const viaContext = discoverFeatureUsage(newProject(), workdir);

        expect(viaImport.notify).toBe(true);
        expect(viaContext.notify).toBe(true);
    });

    it("detects the new Cloudflare-capability features via import or the `ctx.*` helper", () => {
        expect.assertions(12);

        // Imports flip kv / analytics / hyperdrive / images / browser. Pipelines
        // ships from `@lunora/bindings/analytics`, so a plain import must NOT flip it — it is
        // detected solely via the `ctx.pipelines` read (asserted below).
        writeSource("flag.ts", `import { createKv } from "@lunora/bindings/kv";\nexport const a = () => createKv();`);
        writeSource("track.ts", `import { createAnalytics } from "@lunora/bindings/analytics";\nexport const b = () => createAnalytics();`);
        writeSource("pg.ts", `import { createHyperdrive } from "@lunora/hyperdrive";\nexport const c = () => createHyperdrive();`);
        writeSource("img.ts", `import { createImages } from "@lunora/bindings/images";\nexport const d = () => createImages();`);
        writeSource("shot.ts", `import { createBrowser } from "@lunora/browser";\nexport const e = () => createBrowser();`);

        const usage = discoverFeatureUsage(newProject(), workdir);

        expect(usage.kv).toBe(true);
        expect(usage.analytics).toBe(true);
        expect(usage.hyperdrive).toBe(true);
        expect(usage.images).toBe(true);
        expect(usage.browser).toBe(true);
        expect(usage.pipelines).toBe(false);

        // The `ctx.*` reads flip them too — note hyperdrive is reached via `ctx.sql`
        // and pipelines via `ctx.pipelines`.
        rmSync(workdir, { force: true, recursive: true });
        mkdirSync(workdir, { recursive: true });
        writeSource("k.ts", `export const a = async (ctx) => ctx.kv.get("k");`);
        writeSource("a.ts", `export const b = async (ctx) => ctx.analytics.writeDataPoint({});`);
        writeSource("s.ts", `export const c = async (ctx) => ctx.sql.query("select 1");`);
        writeSource("i.ts", `export const d = async (ctx) => ctx.images.transform(x);`);
        writeSource("b.ts", `export const e = async (ctx) => ctx.browser.screenshot("https://x");`);
        writeSource("p.ts", `export const f = async (ctx) => ctx.pipelines.send([]);`);

        const viaCtx = discoverFeatureUsage(newProject(), workdir);

        expect(viaCtx.kv).toBe(true);
        expect(viaCtx.analytics).toBe(true);
        expect(viaCtx.hyperdrive).toBe(true);
        expect(viaCtx.images).toBe(true);
        expect(viaCtx.browser).toBe(true);
        expect(viaCtx.pipelines).toBe(true);
    });

    it("detects ctx.access via a `ctx.access` read or a bare `@lunora/cloudflare-access` import", () => {
        expect.assertions(3);

        writeSource("who.ts", `export const whoAmI = async (ctx) => ctx.access.email;`);
        const viaContext = discoverFeatureUsage(newProject(), workdir);

        rmSync(join(workdir, "who.ts"));
        writeSource("res.ts", `import { createAccessResolver } from "@lunora/cloudflare-access";\nexport const r = () => createAccessResolver({});`);
        const viaImport = discoverFeatureUsage(newProject(), workdir);

        // The `accessContext()` middleware imports the `/context` subpath, NOT the
        // bare specifier — so it must NOT trip the global-wiring probe.
        rmSync(join(workdir, "res.ts"));
        writeSource("mw.ts", `import { accessContext } from "@lunora/cloudflare-access/context";\nexport const q = accessContext();`);
        const viaMiddleware = discoverFeatureUsage(newProject(), workdir);

        expect(viaContext.access).toBe(true);
        expect(viaImport.access).toBe(true);
        expect(viaMiddleware.access).toBe(false);
    });

    it("detects flags via either the `@lunora/flags` import or a `ctx.flags` read", () => {
        expect.assertions(2);

        writeSource("flags.ts", `import { defineFlags } from "@lunora/flags";\nexport default defineFlags({ provider: () => ({}) });`);
        const viaImport = discoverFeatureUsage(newProject(), workdir);

        rmSync(join(workdir, "flags.ts"));
        writeSource("gate.ts", `export const list = async (ctx) => ctx.flags.boolean("x", false);`);
        const viaContext = discoverFeatureUsage(newProject(), workdir);

        expect(viaImport.flags).toBe(true);
        expect(viaContext.flags).toBe(true);
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

    it("detects a `ctx.*` helper destructured under a local alias (matches the source property, not the alias)", () => {
        expect.assertions(1);

        // The source property (`storage`) is what identifies the feature, even when
        // bound to a differently-named local (`bucket`) — the probe keys off the
        // property name, not the binding.
        writeSource("upload.ts", `export const put = async (ctx) => {\n  const { storage: bucket } = ctx;\n  return bucket.put("k", new Blob());\n};`);

        expect(discoverFeatureUsage(newProject(), workdir).storage).toBe(true);
    });

    it("detects containers via either the `@lunora/container` import or a `ctx.containers` read", () => {
        expect.assertions(2);

        // `lunora/containers.ts` importing `defineContainer` from `@lunora/container`.
        writeSource(
            "containers.ts",
            `import { defineContainer } from "@lunora/container";\nexport const transcoder = defineContainer({ image: "./Dockerfile" });`,
        );
        const viaImport = discoverFeatureUsage(newProject(), workdir);

        rmSync(join(workdir, "containers.ts"));
        writeSource("proxy.ts", `export const scale = async (ctx) => ctx.containers.get("transcoder");`);
        const viaContext = discoverFeatureUsage(newProject(), workdir);

        expect(viaImport.container).toBe(true);
        expect(viaContext.container).toBe(true);
    });

    it("detects scheduler via either the package import or `ctx.scheduler`", () => {
        expect.assertions(2);

        writeSource("a.ts", `import { cronJobs } from "@lunora/scheduler";\nexport const c = cronJobs();`);
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
        // only a `@lunora/mail` import should ever flip the flag.
        writeSource("u.ts", `export const f = (user) => user.mail;`);

        expect(discoverFeatureUsage(newProject(), workdir).mail).toBe(false);
    });

    describe("buildStudioFeatures", () => {
        it("hides every page when nothing uses a feature and no signal fires", () => {
            expect.assertions(1);

            expect(buildStudioFeatures(ALL_OFF, NO_SIGNALS)).toStrictEqual({
                analytics: false,
                auth: false,
                containers: false,
                flags: false,
                kv: false,
                mail: false,
                notifications: false,
                payments: false,
                queues: false,
                scheduler: false,
                storage: false,
                vectors: false,
                workflows: false,
            });
        });

        it("shows a page when its code-usage flag is set", () => {
            expect.assertions(1);

            expect(buildStudioFeatures({ ...ALL_OFF, storage: true, vectors: true }, NO_SIGNALS)).toMatchObject({ storage: true, vectors: true });
        });

        it("fails open on the `@lunora/bindings` package name for analytics, kv and vectors", () => {
            expect.assertions(1);

            // Regression: these three arms tested subpaths (`@lunora/bindings/kv`)
            // against a set of package NAMES, so the fail-open arm could never
            // fire — an app depending on `@lunora/bindings` and wiring KV in its
            // worker entry got the page hidden.
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@lunora/bindings"]) })).toMatchObject({
                analytics: true,
                kv: true,
                vectors: true,
            });
        });

        it("shows a page from its schema/project signal even with no code usage", () => {
            expect.assertions(4);

            const result = buildStudioFeatures(ALL_OFF, {
                containerCount: 0,
                cronCount: 1,
                dependencies: new Set<string>(),
                hasPaymentTables: false,
                queueCount: 0,
                storageColumnCount: 2,
                storageRuleCount: 0,
                vectorIndexCount: 3,
                vectorStoreSupported: true,
                workflowCount: 0,
            });

            expect(result.scheduler).toBe(true);
            expect(result.storage).toBe(true);
            expect(result.vectors).toBe(true);
            // mail has no schema signal — it stays hidden until usage or a dependency fires.
            expect(result.mail).toBe(false);
        });

        it("shows a package-backed page when the package is a declared dependency (worker-entry wiring)", () => {
            expect.assertions(1);

            // This is the mail fix: mail is wired in the worker entry, not under `lunora/`,
            // so only the declared dependency keeps its page shown.
            const result = buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@lunora/mail"]) });

            expect(result).toMatchObject({ mail: true });
        });

        it("shows the notifications page from notify usage or a declared @lunora/notify dependency", () => {
            expect.assertions(3);

            // Hidden by default — the Notifications panel only reads `@lunora/notify`
            // devices, so an app without the package has nothing to show there.
            expect(buildStudioFeatures(ALL_OFF, NO_SIGNALS).notifications).toBe(false);
            expect(buildStudioFeatures({ ...ALL_OFF, notify: true }, NO_SIGNALS).notifications).toBe(true);
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@lunora/notify"]) }).notifications).toBe(true);
        });

        it("hides the payments page for a bare @lunora/payment dependency, showing it only once the store tables are declared", () => {
            expect.assertions(3);

            // Payments has no fail-open dependency arm: reusing the package's pure webhook
            // helpers pulls in the dependency without declaring the store tables, so a
            // dependency-only signal would surface a page that errors with
            // `unknown table: subscriptions`. It gates on `hasPaymentTables` instead.
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@lunora/payment"]) }).payments).toBe(false);
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, hasPaymentTables: true }).payments).toBe(true);
            // Actual `ctx.payments` / import usage still fires it (the worker-gating path).
            expect(buildStudioFeatures({ ...ALL_OFF, payments: true }, NO_SIGNALS).payments).toBe(true);
        });

        it("shows the containers page from code usage, a declared container, or an @lunora/container dependency", () => {
            expect.assertions(3);

            expect(buildStudioFeatures({ ...ALL_OFF, container: true }, NO_SIGNALS).containers).toBe(true);
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, containerCount: 1 }).containers).toBe(true);
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@lunora/container"]) }).containers).toBe(true);
        });

        it("shows the flags page from a ctx.flags read or an @lunora/flags dependency", () => {
            expect.assertions(3);

            expect(buildStudioFeatures(ALL_OFF, NO_SIGNALS).flags).toBe(false);
            expect(buildStudioFeatures({ ...ALL_OFF, flags: true }, NO_SIGNALS).flags).toBe(true);
            expect(buildStudioFeatures(ALL_OFF, { ...NO_SIGNALS, dependencies: new Set(["@lunora/flags"]) }).flags).toBe(true);
        });
    });

    describe("hasPaymentStoreTables", () => {
        // A minimal TableIR carrying only what the shape probe reads (its `name` and
        // the column keys of its `shape`); the rest of the IR is irrelevant here.
        const table = (name: string, columns: ReadonlyArray<string>): TableIR =>
            ({ name, shape: Object.fromEntries(columns.map((column) => [column, {}])) }) as unknown as TableIR;

        // The `@lunora/payment` store's canonical `subscriptions` / `events` columns
        // (mirrored by any real payment app — so this is the back-compat path too).
        const paymentSubscriptions = table("subscriptions", ["providerSubscriptionId", "state", "priceId", "referenceId"]);
        const paymentEvents = table("events", ["providerEventId", "processedAt", "type", "provider"]);

        it("detects the payment store by its signature columns", () => {
            expect.assertions(1);

            expect(hasPaymentStoreTables([paymentSubscriptions, paymentEvents])).toBe(true);
        });

        it("does not fire on generically-named tables that lack the payment columns", () => {
            expect.assertions(1);

            // A newsletter `subscriptions` table and a domain `events` table — same names,
            // wrong shape — must not spuriously show the Payments page.
            const newsletter = table("subscriptions", ["email", "topic", "confirmedAt"]);
            const domainEvents = table("events", ["title", "startsAt", "venue"]);

            expect(hasPaymentStoreTables([newsletter, domainEvents])).toBe(false);
        });

        it("requires both store tables to be present", () => {
            expect.assertions(2);

            expect(hasPaymentStoreTables([paymentSubscriptions])).toBe(false);
            expect(hasPaymentStoreTables([paymentEvents])).toBe(false);
        });
    });
});
