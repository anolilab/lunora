import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverContainers } from "../../src/discover/containers";
import { emitContainers, emitServer, emitShard } from "../../src/emit";
import type { SchemaIR } from "../../src/ir";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeContainers = (source: string): void => {
    writeFileSync(join(workdir, "containers.ts"), source);
};

const EMPTY_SCHEMA: SchemaIR = { tables: [], vectorIndexes: [] };

describe("discover/containers", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-container-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/containers.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverContainers(newProject(), workdir)).toEqual([]);
    });

    it("lifts exported defineContainer declarations into IR, sorted by export name", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            export const transcoder = defineContainer({
                image: "./containers/transcoder",
                defaultPort: 8080,
                instanceType: "standard-1",
                maxInstances: 5,
                sleepAfter: "5m",
            });

            export const imageResizer = defineContainer({
                image: { registry: "docker.io/acme/resizer:2.0" },
                instanceType: { vcpu: 1, memoryMib: 4096 },
                name: "resizer-pool",
            });
        `);

        expect(discoverContainers(newProject(), workdir)).toEqual([
            {
                bindingName: "CONTAINER_IMAGE_RESIZER",
                className: "ImageResizerContainer",
                exportName: "imageResizer",
                image: { kind: "registry", reference: "docker.io/acme/resizer:2.0" },
                instanceType: { memoryMib: 4096, vcpu: 1 },
                name: "resizer-pool",
            },
            {
                bindingName: "CONTAINER_TRANSCODER",
                className: "TranscoderContainer",
                exportName: "transcoder",
                image: { buildContext: "./containers/transcoder", dockerfilePath: "./containers/transcoder/Dockerfile", kind: "dockerfile" },
                instanceType: "standard-1",
                maxInstances: 5,
                sleepAfter: "5m",
            },
        ]);
    });

    it("ignores non-defineContainer exports and unexported definitions", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            export const notAContainer = { image: "./x" };
            const internalOnly = defineContainer({ image: "./internal" });
            export const worker = defineContainer({ image: "./containers/worker" });
        `);

        expect(discoverContainers(newProject(), workdir).map((container) => container.exportName)).toEqual(["worker"]);
    });

    it("resolves an aliased defineContainer import", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer as dc } from "@lunora/container";

            export const worker = dc({ image: "./containers/worker" });
        `);

        expect(discoverContainers(newProject(), workdir).map((container) => container.className)).toEqual(["WorkerContainer"]);
    });

    it("rejects a non-literal image with a located diagnostic", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";
            let path = "./containers/worker";
            export const worker = defineContainer({ image: path });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("`image` must be a static string path");
    });

    it("rejects a missing image", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";
            export const worker = defineContainer({ defaultPort: 8080 });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("requires a static `image` property");
    });

    it("rejects a non-literal maxInstances", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";
            const n = Number("5");
            export const worker = defineContainer({ image: "./w", maxInstances: n });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("`maxInstances` must be a static number literal");
    });

    it("allows non-literal runtime-only fields (env, sleepAfter)", () => {
        expect.assertions(2);

        writeContainers(`
            import { defineContainer } from "@lunora/container";
            const level = process.env.LOG_LEVEL ?? "info";
            export const worker = defineContainer({ image: "./w", env: { LOG_LEVEL: level }, sleepAfter: 60 * 5 });
        `);

        const [container] = discoverContainers(newProject(), workdir);

        expect(container).toBeDefined();
        // sleepAfter was a non-literal expression — lifted as undefined, not an error.
        expect(container?.sleepAfter).toBeUndefined();
    });

    it("lifts a Railpack { build } image source", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";
            export const worker = defineContainer({ image: { build: "./services/worker/" } });
        `);

        expect(discoverContainers(newProject(), workdir)[0]?.image).toStrictEqual({ buildDir: "./services/worker", kind: "build" });
    });

    it("lifts literal enableInternet and sleepAfter for the advisor", () => {
        expect.assertions(2);

        writeContainers(`
            import { defineContainer } from "@lunora/container";
            export const worker = defineContainer({ image: "./w", enableInternet: false, sleepAfter: "30s" });
        `);

        const [container] = discoverContainers(newProject(), workdir);

        expect(container?.enableInternet).toBe(false);
        expect(container?.sleepAfter).toBe("30s");
    });
});

describe("emit (containers)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-container-emit-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const discover = (): ReturnType<typeof discoverContainers> => {
        writeContainers(`
            import { defineContainer } from "@lunora/container";
            export const transcoder = defineContainer({ image: "./containers/transcoder", maxInstances: 5 });
        `);

        return discoverContainers(newProject(), workdir);
    };

    it("emitContainers renders one thin DO class per definition", () => {
        expect.assertions(6);

        const content = emitContainers(discover());

        expect(content).toContain('import { LunoraContainer } from "@lunora/container/do";');
        expect(content).toContain('import { transcoder } from "../containers.js";');
        expect(content).toContain('export { ContainerProxy } from "@lunora/container/do";');
        expect(content).toContain("export class TranscoderContainer extends LunoraContainer {");
        expect(content).toContain('super(ctx, env, transcoder, "transcoder");');
        expect(content).toContain("Re-export them from your worker entry");
    });

    it('emitContainers returns "" without containers', () => {
        expect.assertions(1);

        expect(emitContainers([])).toBe("");
    });

    it("emitContainers passes the schema jurisdiction to the base class when declared", () => {
        expect.assertions(1);

        expect(emitContainers(discover(), "us")).toContain('super(ctx, env, transcoder, "transcoder", "us");');
    });

    it("emitContainers omits the jurisdiction arg when undeclared (unchanged output)", () => {
        expect.assertions(1);

        expect(emitContainers(discover())).toContain('super(ctx, env, transcoder, "transcoder");');
    });

    it("emitServer types ctx.containers on ActionCtx only when containers exist", () => {
        expect.assertions(4);

        const withContainers = emitServer({ schema: EMPTY_SCHEMA, containers: discover() });

        expect(withContainers).toContain('import type { ContainerAccessor } from "@lunora/container";');
        expect(withContainers).toContain("readonly containers: {");
        expect(withContainers).toContain("readonly transcoder: ContainerAccessor;");

        expect(emitServer({ schema: EMPTY_SCHEMA })).not.toContain("readonly containers: {");
    });

    it("emitShard wires createContainerContext into the built ctx", () => {
        expect.assertions(4);

        const shard = emitShard({ schema: EMPTY_SCHEMA, containers: discover() });

        expect(shard).toContain('import { createContainerContext } from "@lunora/container";');
        expect(shard).toContain('{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder", maxInstances: 5 },');
        expect(shard).toContain(
            "const containers = createContainerContext(env, LUNORA_CONTAINERS, undefined, this.getCurrentTraceparent(), this.getCurrentSampleErrors());",
        );
        expect(shard).toContain("containers,");
    });

    it("emitShard stays container-free without definitions", () => {
        expect.assertions(1);

        expect(emitShard({ schema: EMPTY_SCHEMA })).not.toContain("LUNORA_CONTAINERS");
    });

    it("emitShard pins ctx.containers to the schema jurisdiction when declared", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: { ...EMPTY_SCHEMA, jurisdiction: "us" }, containers: discover() });

        expect(shard).toContain(
            'const containers = createContainerContext(env, LUNORA_CONTAINERS, "us", this.getCurrentTraceparent(), this.getCurrentSampleErrors());',
        );
    });

    it("reads shorthand and spread wrangler settings through module-scope consts", () => {
        expect.assertions(1);

        // `{ maxInstances, instanceType }` and `{ ...base }` used to be skipped,
        // so the deploy config silently lost `max_instances` / `instance_type`.
        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const maxInstances = 20;
            const instanceType = "standard-4";
            const NODE_VERSION = "22";
            const base = { image: "./containers/base", rollout: { stepPercentage: 25 } };

            export const worker = defineContainer({ ...base, maxInstances, instanceType, buildArgs: { NODE_VERSION } });
        `);

        const [container] = discoverContainers(newProject(), workdir);

        expect({
            buildArgs: container?.buildArgs,
            image: container?.image,
            instanceType: container?.instanceType,
            maxInstances: container?.maxInstances,
            rollout: container?.rollout,
        }).toStrictEqual({
            buildArgs: { NODE_VERSION: "22" },
            image: { buildContext: "./containers/base", dockerfilePath: "./containers/base/Dockerfile", kind: "dockerfile" },
            instanceType: "standard-4",
            maxInstances: 20,
            rollout: { stepPercentage: 25 },
        });
    });

    it("rejects a shorthand wrangler setting it cannot resolve instead of dropping it", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            let maxInstances = 20;

            export const worker = defineContainer({ image: "./containers/worker", maxInstances });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("`maxInstances` is deploy configuration codegen writes into wrangler.jsonc");
    });

    it("rejects an opaque spread that can carry a wrangler setting", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const settings = (): { maxInstances: number; env: Record<string, string> } => ({ maxInstances: 3, env: {} });

            export const worker = defineContainer({ image: "./containers/worker", ...settings() });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("this spread can set `maxInstances`");
    });

    it("leaves an opaque spread of runtime-only fields to the runtime", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const runtime = (): { env: Record<string, string>; defaultPort: number } => ({ env: {}, defaultPort: 8080 });

            export const worker = defineContainer({ image: "./containers/worker", ...runtime() });
        `);

        expect(discoverContainers(newProject(), workdir)).toHaveLength(1);
    });

    it("rejects a buildArgs entry it cannot read statically", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            export const worker = defineContainer({ image: "./containers/worker", buildArgs: { VERSION: process.env.VERSION } });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("`buildArgs.VERSION` must be a static string literal");
    });

    it("rejects two containers whose exports map to one binding name", () => {
        expect.assertions(1);

        // Both normalize to CONTAINER_IMAGE_RESIZER: wrangler would receive two
        // Durable Object bindings under one name.
        writeContainers(`
            import { defineContainer } from "@lunora/container";

            export const imageResizer = defineContainer({ image: "./containers/a" });
            export const image_resizer = defineContainer({ image: "./containers/b" });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow(
            'containers "imageResizer" and "image_resizer" both map to the binding CONTAINER_IMAGE_RESIZER',
        );
    });

    it.each([
        ["an `any` spread", 'const settings: any = JSON.parse("{}");', "...settings"],
        ["a `T | undefined` spread", "const settings = Math.random() > 0.5 ? { maxInstances: 3 } : undefined;", "...settings"],
        ["a union-typed spread", 'const settings = Math.random() > 0.5 ? { maxInstances: 3 } : { sleepAfter: "5m" };', "...settings"],
    ])("refuses %s that can hide a wrangler setting", (_label, declaration, spread) => {
        expect.assertions(1);

        // `getProperties()` on these types is empty (any, `T | undefined`) or
        // only the common keys (a union), so the spread used to be skipped and
        // `max_instances` silently dropped.
        writeContainers(`
            import { defineContainer } from "@lunora/container";

            ${declaration}

            export const worker = defineContainer({ image: "./containers/worker", ${spread} });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow(/this spread can set/u);
    });

    it("refuses a const settings object that is written to elsewhere in the file", () => {
        expect.assertions(1);

        // The initializer says 2; the runtime value is 10. Reading the initializer
        // would deploy `max_instances: 2` for a container that runs with 10.
        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const base = { image: "./containers/worker", maxInstances: 2 };

            base.maxInstances = 10;

            export const worker = defineContainer({ ...base });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow(/`base` is a const object that is written to elsewhere/u);
    });

    it("refuses self-referential spreads with a diagnostic instead of overflowing the stack", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const a: any = { image: "./containers/worker", ...b };
            const b: any = { ...a };

            export const worker = defineContainer({ ...a });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow(/refers back to an object it is part of/u);
    });

    it("reads settings through `as const` and `satisfies`", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const maxInstances = 3 as const;
            const base = { image: "./containers/worker", instanceType: "standard-2" } satisfies Record<string, string>;

            export const worker = defineContainer({ ...base, maxInstances });
        `);

        const [container] = discoverContainers(newProject(), workdir);

        expect({ instanceType: container?.instanceType, maxInstances: container?.maxInstances }).toStrictEqual({ instanceType: "standard-2", maxInstances: 3 });
    });

    it("reads a shorthand whose const aliases another const, like the explicit form", () => {
        expect.assertions(1);

        // `{ maxInstances: LIMIT }` already resolved; `{ maxInstances }` over
        // `const maxInstances = LIMIT` stopped at the identifier and failed the
        // static-number check. Same for guarded keys inside `rollout`.
        writeContainers(`
            import { defineContainer } from "@lunora/container";

            const LIMIT = 3;
            const maxInstances = LIMIT;
            const GRACE = 30;
            const ALIASED_GRACE = GRACE;
            const gracePeriodSeconds = ALIASED_GRACE as const;

            export const worker = defineContainer({ image: "./containers/worker", maxInstances, rollout: { gracePeriodSeconds } });
        `);

        const [container] = discoverContainers(newProject(), workdir);

        expect({ maxInstances: container?.maxInstances, rollout: container?.rollout }).toStrictEqual({ maxInstances: 3, rollout: { gracePeriodSeconds: 30 } });
    });
});
