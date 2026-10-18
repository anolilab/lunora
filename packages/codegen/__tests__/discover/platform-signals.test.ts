import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlatformCodeSignals } from "../../src/discover/platform-signals";
import { discoverPlatformSignals } from "../../src/discover/platform-signals";

let workdir: string;
let project: Project;

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, "lunora", name), source, "utf8");
};

const signals = (): PlatformCodeSignals => discoverPlatformSignals(project, join(workdir, "lunora"));

// eslint-disable-next-line no-secrets/no-secrets -- false positive: a function name in a describe label, not a credential
describe("discoverPlatformSignals", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-platform-signals-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports nothing for an app that declares neither", () => {
        expect.assertions(1);

        write(
            "plain.ts",
            `import { query } from "@lunora/server";\n\nexport const list = query({ args: {}, handler: async (ctx) => ctx.db.query("users").collect() });\n`,
        );

        expect(signals()).toStrictEqual({
            containerEgressPolicy: false,
            deliveryAuthorization: false,
            durableStreams: false,
            liveContext: false,
            liveStreams: false,
            secrets: false,
            typedWebSockets: false,
            workflowRollback: false,
        });
    });

    it("detects a ctx.live read", () => {
        expect.assertions(1);

        write(
            "announce.ts",
            `import { action } from "@lunora/server";\n\nexport const announce = action({ args: {}, handler: async (ctx) => {\n    await ctx.live.publish("posts", { id: 1 });\n\n    return null;\n} });\n`,
        );

        expect(signals().liveContext).toBe(true);
    });

    it("does not treat a `live` binding that is not read off the context as a ctx.live read", () => {
        expect.assertions(1);

        write("toggle.ts", `const live = { publish: () => undefined };\n\nexport const toggle = () => live.publish();\n`);

        expect(signals().liveContext).toBe(false);
    });

    it("flags a socket route or room declaration as typedWebSockets", () => {
        expect.assertions(1);

        write("chat.ts", `export const chat = defineRoom({ name: "chat" });\n`);

        expect(signals().typedWebSockets).toBe(true);
    });

    it("flags a `.deliveryAuthorization(...)` call in the lunora.config.* app hook", () => {
        expect.assertions(2);

        // The hook lives at the project root, outside `lunora/`, so the config
        // file is handed in explicitly rather than found by the walk.
        const configFile = join(workdir, "lunora.config.ts");

        writeFileSync(
            configFile,
            `export default {\n    target: "node",\n    app: (app: { deliveryAuthorization: (selector: () => unknown) => unknown }) => app.deliveryAuthorization(() => undefined),\n};\n`,
            "utf8",
        );

        expect(discoverPlatformSignals(project, join(workdir, "lunora"), configFile).deliveryAuthorization).toBe(true);
        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("flags a `.deliveryAuthorization(...)` call in an app hook extracted to a named function", () => {
        expect.assertions(2);

        // The hook is a binding handed to the `app` key, not written inline.
        const configFile = join(workdir, "lunora.config.ts");
        const hook = `const configure = (app: { deliveryAuthorization: (selector: () => unknown) => unknown }) => app.deliveryAuthorization(() => undefined);\n`;

        writeFileSync(configFile, `${hook}export default {\n    target: "node",\n    app: configure,\n};\n`, "utf8");

        expect(discoverPlatformSignals(project, join(workdir, "lunora"), configFile).deliveryAuthorization).toBe(true);

        writeFileSync(
            configFile,
            `const app = (builder: { deliveryAuthorization: (selector: () => unknown) => unknown }) => builder.deliveryAuthorization(() => undefined);\nexport default {\n    target: "node",\n    app,\n};\n`,
            "utf8",
        );

        expect(discoverPlatformSignals(project, join(workdir, "lunora"), configFile).deliveryAuthorization).toBe(true);
    });

    it("flags a `.deliveryAuthorization(...)` call in a function-declaration app hook", () => {
        expect.assertions(1);

        const configFile = join(workdir, "lunora.config.ts");

        writeFileSync(
            configFile,
            `function configure(app: { deliveryAuthorization: (selector: () => unknown) => unknown }) {\n    return app.deliveryAuthorization(() => undefined);\n}\n\nexport default {\n    target: "node",\n    app: configure,\n};\n`,
            "utf8",
        );

        expect(discoverPlatformSignals(project, join(workdir, "lunora"), configFile).deliveryAuthorization).toBe(true);
    });

    it("flags a `.deliveryAuthorization(...)` call in a method-shorthand app hook", () => {
        expect.assertions(1);

        const configFile = join(workdir, "lunora.config.ts");

        writeFileSync(
            configFile,
            `export default {\n    target: "node",\n    app(app: { deliveryAuthorization: (selector: () => unknown) => unknown }) {\n        return app.deliveryAuthorization(() => undefined);\n    },\n};\n`,
            "utf8",
        );

        expect(discoverPlatformSignals(project, join(workdir, "lunora"), configFile).deliveryAuthorization).toBe(true);
    });

    it("flags `.deliveryAuthorization(...)` chained directly from the defineApp() factory, or on a local bound to it", () => {
        expect.assertions(2);

        write("worker.ts", `export const worker = defineApp().deliveryAuthorization(() => undefined);\n`);

        expect(signals().deliveryAuthorization).toBe(true);

        write("worker.ts", `const app = defineApp();\n\nexport const worker = app.deliveryAuthorization(() => undefined);\n`);
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(signals().deliveryAuthorization).toBe(true);
    });

    it("flags a `.deliveryAuthorization(...)` call on a builder typed AppBuilder and passed in as a parameter", () => {
        expect.assertions(1);

        // The builder is not bound in this file, so the checker types it from
        // the generated class.
        mkdirSync(join(workdir, "_generated"));
        writeFileSync(
            join(workdir, "_generated", "app.ts"),
            `export class AppBuilder<Env extends object> {\n    deliveryAuthorization(selector: (env: Env) => unknown): this {\n        return this;\n    }\n}\n`,
            "utf8",
        );
        write(
            "helper.ts",
            `import type { AppBuilder } from "../_generated/app";\n\nexport const configure = (builder: AppBuilder<object>) => builder.deliveryAuthorization(() => undefined);\n`,
        );

        expect(signals().deliveryAuthorization).toBe(true);
    });

    it("flags a `.deliveryAuthorization(...)` call on a builder imported from another file", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "_generated"));
        writeFileSync(
            join(workdir, "_generated", "app.ts"),
            `export class AppBuilder<Env extends object> {\n    deliveryAuthorization(selector: (env: Env) => unknown): this {\n        return this;\n    }\n}\n`,
            "utf8",
        );
        write("builder.ts", `import type { AppBuilder } from "../_generated/app";\n\nexport declare const app: AppBuilder<object>;\n`);
        write("use.ts", `import { app } from "./builder";\n\nexport const verdict = app.deliveryAuthorization(() => undefined);\n`);

        expect(signals().deliveryAuthorization).toBe(true);
    });

    it("flags a `.deliveryAuthorization(...)` call on a generic parameter constrained to AppBuilder", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "_generated"));
        writeFileSync(
            join(workdir, "_generated", "app.ts"),
            `export class AppBuilder<Env extends object> {\n    deliveryAuthorization(selector: (env: Env) => unknown): this {\n        return this;\n    }\n}\n`,
            "utf8",
        );
        write(
            "helper.ts",
            `import type { AppBuilder } from "../_generated/app";\n\nexport const configure = <T extends AppBuilder<object>>(builder: T) => builder.deliveryAuthorization(() => undefined);\n`,
        );

        expect(signals().deliveryAuthorization).toBe(true);
    });

    it("does not flag a user class that only shares the AppBuilder name, or a local defineApp", () => {
        expect.assertions(2);

        write(
            "builder.ts",
            `class AppBuilder {\n    deliveryAuthorization(value: unknown) {\n        return value;\n    }\n}\n\nexport const verdict = new AppBuilder().deliveryAuthorization(1);\n`,
        );

        expect(signals().deliveryAuthorization).toBe(false);

        write(
            "builder.ts",
            `const defineApp = () => ({ deliveryAuthorization: (value: unknown) => value });\n\nexport const verdict = defineApp().deliveryAuthorization(1);\n`,
        );
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("flags a bracket-form `.deliveryAuthorization(...)` call on the app builder", () => {
        expect.assertions(1);

        // The method is public, so the literal bracket form reaches it too.
        write("worker.ts", `const app = defineApp();\n\nexport const worker = app["deliveryAuthorization"](() => undefined);\n`);

        expect(signals().deliveryAuthorization).toBe(true);
    });

    it("flags a delivery-authorization builder call as deliveryAuthorization", () => {
        expect.assertions(1);

        write("app.ts", `export const app = defineApp().deliveryAuthorization(() => async () => undefined).build();\n`);

        expect(signals().deliveryAuthorization).toBe(true);
    });

    it("does not flag a `deliveryAuthorization` method on an unrelated object", () => {
        expect.assertions(1);

        // Matched by name alone, this produced a node/celld platform diagnostic
        // for any object with that method anywhere under lunora/.
        write(
            "auth.ts",
            `const myObject = { deliveryAuthorization: (value: unknown) => value };\n\nexport const verdict = myObject.deliveryAuthorization(1);\n`,
        );

        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("does not flag a same-named object in a sibling scope as the app builder", () => {
        expect.assertions(1);

        // The module-level `app` is the builder; the `app` inside `helper` is a
        // different binding that happens to carry the same method name.
        write(
            "worker.ts",
            `const app = defineApp();\n\nexport const worker = app.build();\n\nfunction helper() {\n    const app = { deliveryAuthorization: (value: unknown) => value };\n    return app.deliveryAuthorization(1);\n}\n`,
        );

        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("does not flag an `app:` callback on an unrelated object under lunora/ as the app hook", () => {
        expect.assertions(1);

        // Only the project's lunora.config.* carries the app hook. An `app` key
        // on any other object is not the generated builder's hook.
        write(
            "widgets.ts",
            `export const widget = {\n    app: (app: { deliveryAuthorization: (selector: () => unknown) => unknown }) => app.deliveryAuthorization(() => undefined),\n};\n`,
        );

        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("does not flag a shadowed same-named object inside the lunora.config.* app hook", () => {
        expect.assertions(1);

        const configFile = join(workdir, "lunora.config.ts");

        writeFileSync(
            configFile,
            `export default {\n    target: "node",\n    app: (app: { ai: () => unknown }) => {\n        const run = () => {\n            const app = { deliveryAuthorization: () => 1 };\n            return app.deliveryAuthorization();\n        };\n\n        return run() && app.ai();\n    },\n};\n`,
            "utf8",
        );

        expect(discoverPlatformSignals(project, join(workdir, "lunora"), configFile).deliveryAuthorization).toBe(false);
    });

    it("does not flag a bare function call named deliveryAuthorization", () => {
        expect.assertions(1);

        write("auth.ts", `function deliveryAuthorization(value: unknown) {\n    return value;\n}\n\nexport const verdict = deliveryAuthorization(1);\n`);

        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("does not flag an app builder chain that never calls deliveryAuthorization", () => {
        expect.assertions(1);

        write("app.ts", `export const built = (app: { build: () => unknown }) => app.build();\n`);

        expect(signals().deliveryAuthorization).toBe(false);
    });

    it("flags a defineLiveStream declaration as liveStreams", () => {
        expect.assertions(1);

        write("posts.ts", `export const posts = defineLiveStream({ id: "posts" });\n`);

        expect(signals().liveStreams).toBe(true);
    });

    // A host without step rollback fails the step rather than run it without
    // the compensation, so a declared rollback must reach the platform gate.
    it("detects a workflow step that declares a rollback, inline or hoisted", () => {
        expect.assertions(2);

        write(
            "steps.ts",
            `import { defineStep } from "@lunora/workflow";\n\nexport const charge = defineStep("charge", { args: {}, handler: async () => 1, rollback: async () => {} });\n`,
        );

        expect(signals().workflowRollback).toBe(true);

        write(
            "steps.ts",
            `import { defineStep } from "@lunora/workflow";\n\nconst config = { args: {}, handler: async () => 1, rollback: async () => {} };\n\nexport const charge = defineStep("charge", config);\n`,
        );
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(signals().workflowRollback).toBe(true);
    });

    it("does not treat a step without a rollback, or `rollback: undefined`, as a declaration", () => {
        expect.assertions(1);

        write(
            "steps.ts",
            `import { defineStep } from "@lunora/workflow";\n\nexport const a = defineStep("a", { args: {}, handler: async () => 1 });\nexport const b = defineStep("b", { args: {}, handler: async () => 1, rollback: undefined });\n`,
        );

        expect(signals().workflowRollback).toBe(false);
    });

    it("detects a container egress policy by any of its keys, and not an explicit opt-out", () => {
        expect.assertions(2);

        write(
            "containers.ts",
            `import { defineContainer } from "@lunora/container";\n\nexport const box = defineContainer({ image: "./Dockerfile", interceptHttps: false });\n`,
        );

        expect(signals().containerEgressPolicy).toBe(false);

        write(
            "containers.ts",
            `import { defineContainer } from "@lunora/container";\n\nexport const box = defineContainer({ allowedHosts: ["example.com"], image: "./Dockerfile" });\n`,
        );
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        expect(signals().containerEgressPolicy).toBe(true);
    });

    it("detects a durable stream declared on the builder terminal", () => {
        expect.assertions(1);

        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: true });\n`);

        expect(signals().durableStreams).toBe(true);
    });

    it("does not treat an ephemeral stream as durable", () => {
        expect.assertions(1);

        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {});\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("does not treat an explicit `durable: false` as a declaration", () => {
        expect.assertions(1);

        // Presence of the key used to be the whole test, so an app that
        // explicitly opted OUT of durability hard-failed the build on a host
        // that rates durableStreams unsupported.
        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: false });\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("does not treat a parenthesized `durable: (false)` as a declaration", () => {
        expect.assertions(1);

        // The opt-out is read off the initializer's TEXT, so any wrapping the
        // user's formatter leaves behind — `(false)`, `((false))` — used to read
        // as a declaration and hard-fail the build on a host that rates
        // durableStreams unsupported.
        write("feed.ts", `import { procedure } from "@lunora/server";\n\nexport const feed = procedure.stream(async function* () {}, { durable: (false) });\n`);

        expect(signals().durableStreams).toBe(false);
    });

    it("detects a destructured ctx.secrets read", () => {
        expect.assertions(1);

        // The gate exists so codegen refuses an app reading ctx.secrets on a
        // host without a secrets binding, instead of emitting a surface that
        // throws on first use. Matching only `ctx.secrets` handed that app
        // exactly the surface it was supposed to refuse.
        write(
            "keys.ts",
            `import { action } from "@lunora/server";\n\nexport const send = action({ args: {}, handler: async (ctx) => {\n    const { secrets } = ctx;\n\n    return secrets.get("STRIPE_KEY");\n} });\n`,
        );

        expect(signals().secrets).toBe(true);
    });

    it("does not treat an unrelated local `ctx.live` read as a ctx.live read", () => {
        expect.assertions(1);

        // A local named `ctx` that is no handler's context must not block a build on a target that withholds live streams.
        write("scratch.ts", `const ctx = {} as { live?: unknown };\n\nexport const probe = () => ctx.live;\n`);

        expect(signals().liveContext).toBe(false);
    });

    it("detects a ctx.live read through a plain `ctx` parameter", () => {
        expect.assertions(1);

        write(
            "announce.ts",
            `import { action } from "@lunora/server";\n\nexport const announce = action({ args: {}, handler: async (ctx) => ctx.live.publish("posts", {}) });\n`,
        );

        expect(signals().liveContext).toBe(true);
    });

    it("detects a ctx.secrets read", () => {
        expect.assertions(1);

        write(
            "keys.ts",
            `import { action } from "@lunora/server";\n\nexport const send = action({ args: {}, handler: async (ctx) => ctx.secrets.get("STRIPE_KEY") });\n`,
        );

        expect(signals().secrets).toBe(true);
    });
});
