import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverContainers } from "../src/discover-containers";
import { emitContainers, emitServer, emitShard } from "../src/emit";
import type { SchemaIR } from "../src/ir";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeContainers = (source: string): void => {
    writeFileSync(join(workdir, "containers.ts"), source);
};

const EMPTY_SCHEMA: SchemaIR = { tables: [], vectorIndexes: [] };

describe("discover-containers", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-container-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when cirrus/containers.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverContainers(newProject(), workdir)).toEqual([]);
    });

    it("lifts exported defineContainer declarations into IR, sorted by export name", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@cirrus/container";

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
            },
        ]);
    });

    it("ignores non-defineContainer exports and unexported definitions", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@cirrus/container";

            export const notAContainer = { image: "./x" };
            const internalOnly = defineContainer({ image: "./internal" });
            export const worker = defineContainer({ image: "./containers/worker" });
        `);

        expect(discoverContainers(newProject(), workdir).map((container) => container.exportName)).toEqual(["worker"]);
    });

    it("resolves an aliased defineContainer import", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer as dc } from "@cirrus/container";

            export const worker = dc({ image: "./containers/worker" });
        `);

        expect(discoverContainers(newProject(), workdir).map((container) => container.className)).toEqual(["WorkerContainer"]);
    });

    it("rejects a non-literal image with a located diagnostic", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@cirrus/container";
            const path = "./containers/worker";
            export const worker = defineContainer({ image: path });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("`image` must be a static string path");
    });

    it("rejects a missing image", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@cirrus/container";
            export const worker = defineContainer({ defaultPort: 8080 });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("requires a static `image` property");
    });

    it("rejects a non-literal maxInstances", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@cirrus/container";
            const n = 5;
            export const worker = defineContainer({ image: "./w", maxInstances: n });
        `);

        expect(() => discoverContainers(newProject(), workdir)).toThrow("`maxInstances` must be a static number literal");
    });

    it("allows non-literal runtime-only fields (env, sleepAfter)", () => {
        expect.assertions(1);

        writeContainers(`
            import { defineContainer } from "@cirrus/container";
            const level = process.env.LOG_LEVEL ?? "info";
            export const worker = defineContainer({ image: "./w", env: { LOG_LEVEL: level }, sleepAfter: 60 * 5 });
        `);

        expect(discoverContainers(newProject(), workdir)).toHaveLength(1);
    });
});

describe("emit (containers)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-container-emit-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const discover = (): ReturnType<typeof discoverContainers> => {
        writeContainers(`
            import { defineContainer } from "@cirrus/container";
            export const transcoder = defineContainer({ image: "./containers/transcoder", maxInstances: 5 });
        `);

        return discoverContainers(newProject(), workdir);
    };

    it("emitContainers renders one thin DO class per definition", () => {
        expect.assertions(5);

        const content = emitContainers(discover());

        expect(content).toContain('import CirrusContainer from "@cirrus/container/do";');
        expect(content).toContain('import { transcoder } from "../containers.js";');
        expect(content).toContain("export class TranscoderContainer extends CirrusContainer {");
        expect(content).toContain('super(ctx, env, transcoder, "transcoder");');
        expect(content).toContain("Re-export them from your worker entry");
    });

    it('emitContainers returns "" without containers', () => {
        expect.assertions(1);

        expect(emitContainers([])).toBe("");
    });

    it("emitServer types ctx.containers on ActionCtx only when containers exist", () => {
        expect.assertions(4);

        const withContainers = emitServer(false, discover());

        expect(withContainers).toContain('import type { ContainerAccessor } from "@cirrus/container";');
        expect(withContainers).toContain("readonly containers: {");
        expect(withContainers).toContain("readonly transcoder: ContainerAccessor;");

        expect(emitServer(false, [])).not.toContain("containers");
    });

    it("emitShard wires createContainerContext into the built ctx", () => {
        expect.assertions(4);

        const shard = emitShard(EMPTY_SCHEMA, [], undefined, false, discover());

        expect(shard).toContain('import { createContainerContext } from "@cirrus/container";');
        expect(shard).toContain('{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder", maxInstances: 5 },');
        expect(shard).toContain("const containers = createContainerContext(env, CIRRUS_CONTAINERS);");
        expect(shard).toContain("containers,");
    });

    it("emitShard stays container-free without definitions", () => {
        expect.assertions(1);

        expect(emitShard(EMPTY_SCHEMA, [], undefined, false, [])).not.toContain("CIRRUS_CONTAINERS");
    });
});
