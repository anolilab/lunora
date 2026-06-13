import { describe, expect, it } from "vitest";

import {
    containerBindingName,
    containerClassName,
    defineContainer,
    isContainerDefinition,
    normalizeContainerImage,
    resolveContainerEnvVars,
} from "../src/index";

describe(defineContainer, () => {
    it("brands a valid config", () => {
        expect.assertions(2);

        const definition = defineContainer({ defaultPort: 8080, image: "./containers/transcoder", instanceType: "standard-1", maxInstances: 5 });

        expect(definition.isCirrusContainer).toBe(true);
        expect(isContainerDefinition(definition)).toBe(true);
    });

    it("rejects a registry reference passed as a plain string", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "docker.io/acme/transcoder:1.4" })).toThrow("looks like a registry reference");
    });

    it("rejects an empty image", () => {
        expect.assertions(2);

        expect(() => defineContainer({ image: "" })).toThrow("non-empty");
        expect(() => defineContainer({ image: { registry: "" } })).toThrow("non-empty");
    });

    it("rejects an out-of-range defaultPort", () => {
        expect.assertions(2);

        expect(() => defineContainer({ defaultPort: 0, image: "./app" })).toThrow("defaultPort");
        expect(() => defineContainer({ defaultPort: 70_000, image: "./app" })).toThrow("defaultPort");
    });

    it("rejects a non-positive maxInstances", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "./app", maxInstances: 0 })).toThrow("maxInstances");
    });

    it("rejects an unknown named instanceType", () => {
        expect.assertions(1);

        // @ts-expect-error -- deliberately invalid name
        expect(() => defineContainer({ image: "./app", instanceType: "mega" })).toThrow("unknown `instanceType`");
    });

    it("accepts a custom instance type object", () => {
        expect.assertions(1);

        expect(defineContainer({ image: "./app", instanceType: { diskMb: 4000, memoryMib: 4096, vcpu: 1 } }).instanceType).toStrictEqual({
            diskMb: 4000,
            memoryMib: 4096,
            vcpu: 1,
        });
    });

    it("rejects an invalid secret name", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "./app", secrets: ["NOT-VALID"] })).toThrow("not a valid environment variable name");
    });

    it("accepts a Railpack { build } image source", () => {
        expect.assertions(1);

        expect(defineContainer({ image: { build: "./services/worker" } }).isCirrusContainer).toBe(true);
    });

    it("rejects an empty { build } source", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: { build: "" } })).toThrow("`image.build` must be a non-empty");
    });

    it("does not brand arbitrary objects", () => {
        expect.assertions(2);

        expect(isContainerDefinition({})).toBe(false);
        expect(isContainerDefinition(undefined)).toBe(false);
    });
});

describe(containerClassName, () => {
    it("derives the generated DO class name", () => {
        expect.assertions(2);

        expect(containerClassName("transcoder")).toBe("TranscoderContainer");
        expect(containerClassName("imageResizer")).toBe("ImageResizerContainer");
    });
});

describe(containerBindingName, () => {
    it("derives the CONTAINER_* binding name", () => {
        expect.assertions(3);

        expect(containerBindingName("transcoder")).toBe("CONTAINER_TRANSCODER");
        expect(containerBindingName("imageResizer")).toBe("CONTAINER_IMAGE_RESIZER");
        expect(containerBindingName("ffmpeg2Pass")).toBe("CONTAINER_FFMPEG2_PASS");
    });
});

describe(normalizeContainerImage, () => {
    it("treats a directory as the build context with a default Dockerfile", () => {
        expect.assertions(2);

        expect(normalizeContainerImage("./containers/transcoder")).toStrictEqual({
            buildContext: "./containers/transcoder",
            dockerfilePath: "./containers/transcoder/Dockerfile",
            kind: "dockerfile",
        });
        expect(normalizeContainerImage("./containers/transcoder/")).toStrictEqual({
            buildContext: "./containers/transcoder",
            dockerfilePath: "./containers/transcoder/Dockerfile",
            kind: "dockerfile",
        });
    });

    it("uses an explicit Dockerfile path as-is", () => {
        expect.assertions(2);

        expect(normalizeContainerImage("./containers/transcoder/Dockerfile")).toStrictEqual({
            buildContext: "./containers/transcoder",
            dockerfilePath: "./containers/transcoder/Dockerfile",
            kind: "dockerfile",
        });
        expect(normalizeContainerImage("./containers/transcoder/Dockerfile.dev")).toStrictEqual({
            buildContext: "./containers/transcoder",
            dockerfilePath: "./containers/transcoder/Dockerfile.dev",
            kind: "dockerfile",
        });
    });

    it("passes a registry reference through", () => {
        expect.assertions(1);

        expect(normalizeContainerImage({ registry: "docker.io/acme/transcoder:1.4" })).toStrictEqual({
            kind: "registry",
            reference: "docker.io/acme/transcoder:1.4",
        });
    });

    it("normalizes a Railpack { build } source, trimming a trailing slash", () => {
        expect.assertions(2);

        expect(normalizeContainerImage({ build: "./services/worker" })).toStrictEqual({ buildDir: "./services/worker", kind: "build" });
        expect(normalizeContainerImage({ build: "./services/worker/" })).toStrictEqual({ buildDir: "./services/worker", kind: "build" });
    });
});

describe(resolveContainerEnvVars, () => {
    it("merges static env with resolved secrets", () => {
        expect.assertions(1);

        const definition = defineContainer({ env: { LOG_LEVEL: "info" }, image: "./app", secrets: ["API_KEY"] });

        expect(resolveContainerEnvVars(definition, { API_KEY: "s3cret", UNRELATED: "x" })).toStrictEqual({ API_KEY: "s3cret", LOG_LEVEL: "info" });
    });

    it("fails fast on a declared but unset secret", () => {
        expect.assertions(1);

        const definition = defineContainer({ image: "./app", secrets: ["API_KEY"] });

        expect(() => resolveContainerEnvVars(definition, {}, "transcoder")).toThrow('container "transcoder": declared secret "API_KEY" is not set');
    });
});
