import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlatformCapabilities } from "@lunora/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityKey } from "../src/capabilities";
import type { FeatureUsage } from "../src/discover/feature-usage";
import { readProjectTarget, resolveCodegenTarget } from "../src/platform-target";
import { runCodegen } from "../src/run-codegen";

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

describe("gatePlatformFeatures", () => {
    it("is the identity for the default Cloudflare target (nothing unsupported)", async () => {
        expect.assertions(2);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, ai: true, browser: true, images: true, storage: true, workflows: true };

        const result = gatePlatformFeatures(usage, "cloudflare");

        expect(result.diagnostics).toStrictEqual([]);
        // A copy, byte-for-byte equal — the emitted surface (and goldens) is unchanged.
        expect(result.usage).toStrictEqual(usage);
    });

    it("omits an unsupported feature and reports it", async () => {
        expect.assertions(4);

        // A synthetic target that lacks browser + object storage. Cloudflare marks
        // nothing unsupported, so the omission path needs a matrix that does —
        // which is exactly what a real per-target platform package would provide.
        // `gateAgainstMatrix` takes the matrix directly, so no module mocking.
        const partialTarget: PlatformCapabilities = {
            id: "partial",
            name: "Partial Host",
            features: {
                ai: { level: "native" },
                browser: { level: "unsupported" },
                objectStorage: { level: "unsupported" },
                workflows: { level: "emulated" },
            },
        };

        const { gateAgainstMatrix } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, ai: true, browser: true, storage: true, workflows: true };

        const result = gateAgainstMatrix(usage, partialTarget, "partial");

        // Unsupported features flipped off; supported (native/emulated) left on.
        expect(result.usage.browser).toBe(false);
        expect(result.usage.storage).toBe(false);
        expect({ ai: result.usage.ai, workflows: result.usage.workflows }).toStrictEqual({ ai: true, workflows: true });

        // One diagnostic per omitted feature, each naming the ctx surface.
        expect(result.diagnostics.map((diagnostic) => diagnostic.feature).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual([
            "browser",
            "storage",
        ]);
    });

    it("fails closed on a feature the matrix omits, under its own diagnostic name", async () => {
        expect.assertions(5);

        // A partial matrix that RATES `ai` but says nothing about `browser` — the
        // shape a WIP second host ships mid-implementation. `browser` must not
        // silently pass through just because the key is absent: every `features`
        // key is optional, so an omission is indistinguishable from "unsupported"
        // unless the gate treats it as such.
        const partialTarget: PlatformCapabilities = {
            id: "partial",
            name: "Partial Host",
            features: {
                ai: { level: "native" },
            },
        };

        const { gateAgainstMatrix } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, ai: true, browser: true };

        const result = gateAgainstMatrix(usage, partialTarget, "partial");

        // Fails closed: the surface is omitted exactly as an explicit "unsupported" would be.
        expect(result.usage.browser).toBe(false);
        expect(result.usage.ai).toBe(true);

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.name).toBe("platform_undeclared_feature");
        expect(result.diagnostics[0]?.feature).toBe("browser");
    });

    it("reports an unknown target and leaves the surface un-gated", async () => {
        expect.assertions(3);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, browser: true };

        const result = gatePlatformFeatures(usage, "some-future-host");

        // Fail safe: no matrix to gate against → nothing omitted...
        expect(result.usage).toStrictEqual(usage);
        // ...but a single error diagnostic flags the unconfigured target.
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.name).toBe("platform_unknown_target");
    });

    it("never gates app-level features that have no platform mapping", async () => {
        expect.assertions(1);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        // flags / access / payments / x402 / r2sql / notify are credential-based
        // add-ons (they work anywhere fetch works), not platform primitives — they
        // must survive any target unchanged. `images` is NOT in this list: it is
        // binding-based (`env.IMAGES`) and gated like `browser`/`vectors`. The
        // list is spelled out here and derived from the source in "capability
        // classification" below, which is what stops the two drifting again.
        const usage: FeatureUsage = { ...ALL_OFF, access: true, flags: true, notify: true, payments: true, r2sql: true, x402: true };

        const result = gatePlatformFeatures(usage, "cloudflare");

        expect(result.usage).toStrictEqual(usage);
    });

    // Plan 234: `node` is a REGISTERED target (unlike the synthetic "partial"
    // matrix above), so this exercises the real `NODE_CAPABILITIES` matrix
    // through the actual registry lookup — the thing `platformMatrixIds`
    // reports and `resolveCodegenTarget`/`lunora.json`'s `target` field select.
    it("gates a project declaring an unsupported ctx.* for the node target", async () => {
        expect.assertions(6);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        // `browser`, `container`, and `images` are rated "unsupported" for node
        // (`NODE_CAPABILITIES` — no headless-browser, container, or Images
        // binding is implemented by `@lunora/platform-node`), so codegen gates
        // all three off.
        //
        // `scheduler` was gated off too under plan 267, when the Node host
        // stored and timed jobs but never dispatched them. It dispatches now
        // (`onDispatch`) and re-arms its durable rows on construction, so it is
        // back to "emulated" and must survive gating — alongside `kv`, which
        // has been a real better-sqlite3-backed implementation throughout.
        const usage: FeatureUsage = { ...ALL_OFF, browser: true, container: true, images: true, kv: true, scheduler: true };

        const result = gatePlatformFeatures(usage, "node");

        expect(result.usage.browser).toBe(false);
        expect(result.usage.container).toBe(false);
        expect(result.usage.images).toBe(false);
        expect(result.usage.scheduler).toBe(true);
        expect(result.usage.kv).toBe(true);
        expect(result.diagnostics.map((diagnostic) => diagnostic.feature).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual([
            "browser",
            "container",
            "images",
        ]);
    });

    // `celld` is the second spike target (see `@lunora/platform-celld`): a
    // Workers-compatible self-hosted Durable Objects runtime whose matrix
    // (`CELLD_CAPABILITIES`, tracking celld v0.4.0) rates the bindings celld
    // actually ships — KV, R2, D1, Workflows, Cron Triggers — as real support,
    // so those must survive gating. What it gates is the managed Cloudflare
    // services celld has no binding for (`ai`, `vectors`) plus the two blocked
    // for a reason that is NOT a missing binding: `mail`, and the `queues` it
    // rides on, because a celld queue consumer cannot also export `fetch()`
    // and a Lunora app is one worker exporting both.
    it("gates the celld target on what celld actually lacks, not on the whole surface", async () => {
        expect.assertions(6);

        const { gatePlatformFeatures } = await import("../src/platform-target");
        const usage: FeatureUsage = { ...ALL_OFF, ai: true, kv: true, mail: true, scheduler: true, storage: true, vectors: true };

        const result = gatePlatformFeatures(usage, "celld");

        expect(result.usage.kv).toBe(true);
        expect(result.usage.storage).toBe(true);
        expect(result.usage.scheduler).toBe(true);
        expect(result.usage.mail).toBe(false);
        expect(result.diagnostics.every((diagnostic) => diagnostic.name === "platform_unsupported_feature")).toBe(true);
        expect(result.diagnostics.map((diagnostic) => diagnostic.feature).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual([
            "ai",
            "mail",
            "vectors",
        ]);
    });
});

describe("project-declared target", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixtureRoot = join(here, "fixtures", "simple");
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-target-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeConfig = (text: string): void => {
        writeFileSync(join(workdir, "lunora.json"), text, "utf8");
    };

    const diagnosticNames = (target?: string): string[] =>
        runCodegen({ projectRoot: workdir, target }).platformDiagnostics.map((diagnostic) => diagnostic.name);

    it("gates against the project's declared target when the caller passes none", () => {
        expect.assertions(2);

        expect(diagnosticNames()).toStrictEqual([]);

        writeConfig(`{ "target": "aws" }`);

        // The point of resolving inside `runCodegen`: a call site that forgets
        // to thread a target would otherwise emit the DEFAULT surface with no
        // diagnostic at all, and the mismatch would only surface at runtime on
        // the deployed app.
        expect(diagnosticNames()).toStrictEqual(["platform_unknown_target"]);
    });

    it("recognises node as a registered target end-to-end through runCodegen", () => {
        expect.assertions(1);

        // The `simple` fixture uses none of the gated ctx.* surfaces, so a
        // recognised target with an honest matrix produces no diagnostics —
        // same shape as the default Cloudflare case above, proving `node` is
        // resolved through the real registry (`PLATFORM_MATRICES`), not
        // rejected as `platform_unknown_target` the way "aws" is.
        writeConfig(`{ "target": "node" }`);

        expect(diagnosticNames()).toStrictEqual([]);
    });

    it("recognises celld as a registered target end-to-end through runCodegen", () => {
        expect.assertions(1);

        // Same shape as the `node` case: the fixture uses no gated ctx.*
        // surface, so a registered target resolves through `PLATFORM_MATRICES`
        // with no diagnostics rather than failing as `platform_unknown_target`.
        writeConfig(`{ "target": "celld" }`);

        expect(diagnosticNames()).toStrictEqual([]);
    });

    it("reads the target as JSONC, matching how the rest of lunora.json is parsed", () => {
        expect.assertions(1);

        // `@lunora/config` parses this file with `jsonc-parser`. A second reader
        // using plain `JSON.parse` would reject a config the CLI accepts, which
        // is exactly the drift a shared parser exists to prevent.
        writeConfig(`{\n    // the target we ship to\n    "target": "aws",\n}`);

        expect(diagnosticNames()).toStrictEqual(["platform_unknown_target"]);
    });

    it("lets an explicit target override the project config", () => {
        expect.assertions(1);

        writeConfig(`{ "target": "aws" }`);

        expect(diagnosticNames("cloudflare")).toStrictEqual([]);
    });

    it("degrades to the default on an unusable config rather than throwing", () => {
        expect.assertions(3);

        writeConfig("{ not json");

        expect(readProjectTarget(workdir)).toBeUndefined();

        writeConfig(`{ "target": 42 }`);

        // A non-string is a shape error, not a name the user meant — unlike a
        // misspelled string, which must reach the registry and be rejected.
        expect(readProjectTarget(workdir)).toBeUndefined();
        expect(resolveCodegenTarget(workdir)).toBe("cloudflare");
    });
});

describe("capability classification", () => {
    /** A matrix that rates nothing — the shape a WIP host ships before it fills its features in. */
    const EMPTY_MATRIX: PlatformCapabilities = { id: "empty", name: "Empty Host", features: {} };

    it("covers every capability the codegen table declares", async () => {
        expect.assertions(1);

        const { CAPABILITIES } = await import("../src/capabilities");
        const { CAPABILITY_TO_FEATURE } = await import("../src/platform-target");

        // `CAPABILITY_TO_FEATURE` is a total `Record`, so a `CapabilityKey` with no
        // classification fails `tsc` rather than this test — that is the enforcement,
        // and it is why the old complement-list-plus-partition-test is gone. What
        // `tsc` cannot see is the OTHER direction: `CAPABILITIES` is a runtime array,
        // and a row added there without widening `CapabilityKey` would leave a real
        // capability absent from the map. That is the fail-open `notify` had, where
        // `gateAgainstMatrix` never iterated it and `ctx.notify` shipped un-gated.
        expect(CAPABILITIES.map((capability) => capability.key).filter((key) => !(key in CAPABILITY_TO_FEATURE))).toStrictEqual([]);
    });

    it("fails closed for every gated capability against a matrix that rates nothing", async () => {
        expect.assertions(2);

        const { CAPABILITY_TO_FEATURE, gateAgainstMatrix } = await import("../src/platform-target");
        const gatedKeys = (Object.entries(CAPABILITY_TO_FEATURE) as [CapabilityKey, string | null][])
            .filter(([, feature]) => feature !== null)
            .map(([key]) => key);
        const usage: FeatureUsage = { ...ALL_OFF, ...Object.fromEntries(gatedKeys.map((key) => [key, true])) };

        const result = gateAgainstMatrix(usage, EMPTY_MATRIX, "empty");

        // Generalizes the single-feature `browser` case above to the whole map: a
        // mapped capability the matrix says nothing about is dropped and diagnosed.
        expect(gatedKeys.filter((key) => result.usage[key])).toStrictEqual([]);
        expect(result.diagnostics.map((diagnostic) => diagnostic.feature).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(
            gatedKeys.toSorted((a, b) => a.localeCompare(b)),
        );
    });

    it("emits the credential-based capabilities un-gated on a matrix that rates nothing", async () => {
        expect.assertions(2);

        const { CAPABILITY_TO_FEATURE, gateAgainstMatrix } = await import("../src/platform-target");
        const exempt = (Object.entries(CAPABILITY_TO_FEATURE) as [CapabilityKey, string | null][])
            .filter(([, feature]) => feature === null)
            .map(([key]) => key);

        // `notify` is deliberately classified credential-based rather than mapped:
        // Web Push / FCM are `fetch` under VAPID / FCM credentials, the subscription
        // store is caller-supplied with an in-memory fallback, and the fan-out seam
        // takes the producer as an argument — nothing in `@lunora/notify` holds a
        // host binding, so there is no target on which the surface should be dropped.
        expect(exempt).toContain("notify");

        const usage: FeatureUsage = { ...ALL_OFF, ...Object.fromEntries(exempt.map((key) => [key, true])) };

        expect(gateAgainstMatrix(usage, EMPTY_MATRIX, "empty")).toStrictEqual({ diagnostics: [], signals: {}, usage });
    });
});

describe("app-declarable signals with no capability row", () => {
    /** A matrix that rates nothing — the shape a WIP host ships before it fills its features in. */
    const EMPTY_MATRIX: PlatformCapabilities = { features: {}, id: "empty", name: "Empty Host" };

    it("diagnoses a declared feature the target marks unsupported", async () => {
        expect.assertions(3);

        // Regression: `CAPABILITY_TO_FEATURE` only covers app-imported `ctx.*`
        // add-ons, so `durableStreams` (and `globalTables` / `queues` /
        // `crossShardFanout` / `secrets`) were rated in every matrix and consulted
        // by nothing — a durable `.stream()` on `target: "node"` emitted its full
        // surface with no diagnostic and silently behaved as ephemeral.
        const { gateAgainstMatrix } = await import("../src/platform-target");
        const matrix: PlatformCapabilities = {
            features: { durableStreams: { level: "unsupported" }, secrets: { level: "native" } },
            id: "some-host",
            name: "Some Host",
        };

        const result = gateAgainstMatrix(ALL_OFF, matrix, "some-host", { durableStreams: true, secrets: true });

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.name).toBe("platform_unsupported_feature");
        expect(result.diagnostics[0]?.message).toContain("durable streams");
    });

    it("diagnoses a `.commitOrdered()` table the target cannot order", async () => {
        expect.assertions(3);

        // `commitOrderedTables` was rated in every matrix and read by nothing, so
        // a host marking it unsupported emitted the full `.commitOrdered()`
        // surface and silently dropped the ordering guarantee — which is the only
        // thing the feature is.
        const { gateAgainstMatrix } = await import("../src/platform-target");
        const matrix: PlatformCapabilities = {
            features: { commitOrderedTables: { level: "unsupported" } },
            id: "some-host",
            name: "Some Host",
        };

        const result = gateAgainstMatrix(ALL_OFF, matrix, "some-host", { commitOrderedTables: true });

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.name).toBe("platform_unsupported_feature");
        expect(result.diagnostics[0]?.message).toContain("commit-ordered tables");
    });

    it("fails closed on an unrated app-declarable feature", async () => {
        expect.assertions(2);

        const { gateAgainstMatrix } = await import("../src/platform-target");
        const result = gateAgainstMatrix(ALL_OFF, EMPTY_MATRIX, "empty", { globalTables: true });

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.name).toBe("platform_undeclared_feature");
    });

    it("reports a feature reachable both ways exactly once, and still rejects it", async () => {
        expect.assertions(4);

        // `vectorStore` is a capability (`ctx.vectors`) AND a schema signal
        // (`.vectorize()`), and an app that does both has one problem, not two.
        const { gateAgainstMatrix } = await import("../src/platform-target");
        const matrix: PlatformCapabilities = { features: { vectorStore: { level: "unsupported" } }, id: "some-host", name: "Some Host" };

        const result = gateAgainstMatrix({ ...ALL_OFF, vectors: true }, matrix, "some-host", { vectorStore: true });

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.feature).toBe("vectors");

        // Deduping the DIAGNOSTIC must not dedupe the REJECTION. Leaving the
        // signal `true` here let `hasVectors` read it as accepted and emit
        // `ctx.vectors` anyway — in the most common shape, since an app that
        // declares a vector index almost always queries it too.
        expect(result.usage.vectors).toBe(false);
        expect(result.signals.vectorStore).toBe(false);
    });

    it("says nothing about a feature the app does not declare", async () => {
        expect.assertions(1);

        const { gateAgainstMatrix } = await import("../src/platform-target");

        expect(gateAgainstMatrix(ALL_OFF, EMPTY_MATRIX, "empty", { durableStreams: false }).diagnostics).toStrictEqual([]);
    });
});

/**
 * The gate as an app author meets it: a real `runCodegen` over a real project
 * whose `lunora.json` declares `target: "node"`, asserting on what codegen
 * EMITTED — the diagnostics it returned and the surface it wrote — rather than
 * on an intermediate flag. Asserting the flag is how the `browserTool` hole
 * below survived a passing test suite: `usage.browser` was correctly `false`
 * while `ctx.browser` was emitted anyway.
 */
describe("app-declared surfaces, gated end-to-end through runCodegen", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixtureRoot = join(here, "fixtures", "simple");
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-target-node-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora.json"), `{ "target": "node" }`, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const write = (name: string, source: string): void => {
        writeFileSync(join(workdir, "lunora", name), source, "utf8");
    };

    /** Append a table to the fixture schema's `defineSchema({ … })` object. */
    const appendTable = (source: string): void => {
        const schemaPath = join(workdir, "lunora", "schema.ts");
        const text = readFileSync(schemaPath, "utf8");
        const close = text.lastIndexOf("});");

        writeFileSync(schemaPath, `${text.slice(0, close)}${source}\n${text.slice(close)}`, "utf8");
    };

    const codegen = (): ReturnType<typeof runCodegen> => runCodegen({ projectRoot: workdir });

    it("gates a declared cron on a target where nothing dispatches one", () => {
        expect.assertions(3);

        // The `featureUsage` arm cannot cover this: it keys `scheduler` on a
        // `@lunora/scheduler` import, while `cronJobs` is legitimately imported
        // from `@lunora/server`. Before the signal existed, this app built green
        // on a host where the nightly sweep never fires.
        write(
            "crons.ts",
            `import { cronJobs } from "@lunora/server";\n\nconst crons = cronJobs();\n\ncrons.daily("nightly-billing-sweep", { hourUTC: 3, minuteUTC: 0 }, internal.messages.purge, {});\n\nexport default crons;\n`,
        );

        const result = codegen();

        // The cron IS declared and emitted — the diagnostic is the only thing
        // standing between it and a deploy where it never fires.
        expect(result.cronTriggers).toStrictEqual(["0 3 * * *"]);
        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.platformDiagnostics[0]?.message).toContain("cron");
    });

    it("gates a schema-declared vector index the target has no binding for", () => {
        expect.assertions(6);

        // `ctx.vectors` is emitted off `schema.vectorIndexes`, never off the
        // gated `featureUsage.vectors` — and a `.vectorize()` declaration flips
        // neither the import probe nor the `ctx.vectors` read the usage arm
        // watches for.
        appendTable(`    docs: defineTable({ body: v.string() }).vectorize("body", { dimensions: 768, index: "docs_search", metric: "cosine" }),`);

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.platformDiagnostics[0]?.message).toContain("vector");

        // And the surface is actually WITHHELD, not merely complained about,
        // by EVERY emitter that carries it. Asserting only the diagnostic is how
        // the sibling `browser` gate came to be re-enabled downstream without any
        // test noticing: the flag said "off" while the emitted bytes said
        // otherwise. Asserting only ONE of the three emitters is how the shard
        // kept the whole Vectorize wiring — the import, the `createVectorSyncHook`
        // write hook and `vectors` on the runtime ctx — on a target with no
        // vector binding at all, while `server.ts` and `app.ts` correctly
        // withheld theirs.
        expect(result.generated.server).not.toContain("readonly vectors:");
        expect(result.generated.app).not.toContain(".vectors(");
        expect(result.generated.shard).not.toContain("createVectorSyncHook");
        expect(result.generated.shard).not.toContain("@lunora/bindings/vectors");
    });

    it("withholds the sharded-vector wiring, down to the ROOT_SHARD_NAME import it reads", () => {
        expect.assertions(3);

        // A `.shardBy()`'d vectorized table adds a second, separately-gated
        // fragment: the shard-key namespace scoping, whose `ROOT_SHARD_NAME`
        // sentinel is imported from `@lunora/do` off its own flag. Gating only
        // the main wiring leaves that import behind, unused, in a file that
        // imports nothing else it needs.
        appendTable(
            `    docs: defineTable({ body: v.string(), tenantId: v.string() }).shardBy("tenantId").vectorize("body", { dimensions: 768, index: "docs_search", metric: "cosine" }),`,
        );

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.generated.shard).not.toContain("createVectorSyncHook");
        expect(result.generated.shard).not.toContain("ROOT_SHARD_NAME");
    });

    it("does not demand the vector binding package on a target with no vector store", () => {
        expect.assertions(2);

        // The required-package check is keyed off the schema, so it read the raw
        // `.vectorize()` count and hard-FAILED codegen unless the project
        // installed `@lunora/bindings` — for a binding this host does not have,
        // after the gate had already told the app the feature is unsupported.
        // The generated output imports nothing from it here, so nothing is
        // required.
        // `@lunora/d1` is what the fixture's `.global()` table legitimately needs; the
        // question here is only whether the vector binding is demanded alongside it.
        writeFileSync(join(workdir, "package.json"), `{ "name": "gated", "dependencies": { "@lunora/d1": "*", "@lunora/storage": "*" } }`, "utf8");
        appendTable(`    docs: defineTable({ body: v.string() }).vectorize("body", { dimensions: 768, index: "docs_search", metric: "cosine" }),`);

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.generated.shard).not.toContain("@lunora/bindings/vectors");
    });

    it("hides the studio's vector browser on a target with no vector store", () => {
        expect.assertions(3);

        // The studio nav reads `studioFeatures.vectors` out of the emitted shard.
        // That flag was built from the RAW `.vectorize()` count and the raw
        // `@lunora/bindings` dependency, both un-gated — so the same build that
        // withheld `ctx.vectors` from the shard shipped a Vector browser entry
        // advertising a binding this host does not have. BOTH arms have to fall
        // to the platform verdict, not just the count: an app depending on
        // `@lunora/bindings` for `ctx.kv` would otherwise keep the page.
        writeFileSync(
            join(workdir, "package.json"),
            `{ "name": "gated", "dependencies": { "@lunora/bindings": "*", "@lunora/d1": "*", "@lunora/storage": "*" } }`,
            "utf8",
        );
        appendTable(`    docs: defineTable({ body: v.string() }).vectorize("body", { dimensions: 768, index: "docs_search", metric: "cosine" }),`);

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.generated.shard).toContain(`"vectors": false`);
        // The sibling `@lunora/bindings` feature stays on — the verdict is
        // per-capability, and `keyValueStore` is `emulated` on this target.
        expect(result.generated.shard).toContain(`"kv": true`);
    });

    it("gates ctx.browser reached through @lunora/agent's browserTool exactly as it gates a direct import", () => {
        expect.assertions(4);

        const browserField = `readonly browser: import("@lunora/browser").Browser;`;

        write("tools.ts", `import { browserTool } from "@lunora/agent";\n\nexport const tools = [browserTool()];\n`);

        const viaTool = codegen();

        expect(viaTool.platformDiagnostics.map((diagnostic) => diagnostic.feature)).toStrictEqual(["browser"]);
        expect(viaTool.generated.server).not.toContain(browserField);

        // The direct import has always been gated; the tool import must not be
        // the way around it.
        write("tools.ts", `import { createBrowser } from "@lunora/browser";\n\nexport const browser = createBrowser;\n`);

        const viaImport = codegen();

        expect(viaImport.platformDiagnostics.map((diagnostic) => diagnostic.feature)).toStrictEqual(["browser"]);
        expect(viaImport.generated.server).not.toContain(browserField);
    });

    it("gates a destructured ctx.secrets read, not only a direct property access", () => {
        expect.assertions(2);

        write(
            "keys.ts",
            `import { action } from "@lunora/server";\n\nexport const send = action({ args: {}, handler: async (ctx) => {\n    const { secrets } = ctx;\n\n    return secrets.get("STRIPE_KEY");\n} });\n`,
        );

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.platformDiagnostics[0]?.message).toContain("secrets");
    });

    it.each([
        ["plain", `async ({ ctx }) => ctx.secrets.get("STRIPE_KEY")`],
        ["renamed", `async ({ ctx: context }) => context.secrets.get("STRIPE_KEY")`],
        ["destructured", `async ({ ctx: { secrets } }) => secrets.get("STRIPE_KEY")`],
    ])("gates ctx.secrets reached through a %s handler context parameter", (_form, handler) => {
        expect.assertions(2);

        // A handler receives its context as a property of ONE destructured
        // argument (`async ({ args, ctx }) => …`), so the local name the context
        // is bound to is the handler's to choose. Matching the identifier text
        // `ctx` recognised only the shorthand: renaming the binding or
        // destructuring it built green on a host that rates `secrets`
        // unsupported, and `ctx.secrets.get()` then threw `no Secrets Store
        // binding named "…"` on first use — the exact failure this gate refuses.
        // `secrets` has no import arm and no capability row, so nothing else
        // covers it.
        write("keys.ts", `import { action } from "@lunora/server";\n\nexport const send = action.action(${handler});\n`);

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.platformDiagnostics[0]?.message).toContain("secrets");
    });

    it.each([
        ["an inline object literal", `export const feed = procedure.stream(async function* () {}, { durable: true });`],
        ["a variable", `const streamOptions = { durable: true };\n\nexport const feed = procedure.stream(async function* () {}, streamOptions);`],
    ])("gates a durable stream declared with %s", (_form, source) => {
        expect.assertions(2);

        // `durable` is carried in no IR — the emitted registry reads it off the
        // registration object at runtime — so the signal is syntactic. Requiring
        // the argument to BE an object literal meant hoisting the options into a
        // variable slipped the gate, and the stream silently ran as ephemeral on
        // a host with no durable stream storage.
        write("feed.ts", `import { procedure } from "@lunora/server";\n\n${source}\n`);

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.platformDiagnostics[0]?.message).toContain("durable");
    });

    it("gates a declared agent on a target that cannot run one", () => {
        expect.assertions(2);

        write("agents.ts", `import { defineAgent } from "@lunora/agent";\n\nexport const support = defineAgent({ model: "m" });\n`);

        const result = codegen();

        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
        expect(result.platformDiagnostics[0]?.message).toContain("agent");
    });
});
