import { describe, expect, it } from "vitest";

import {
    containerBindingName,
    containerBuildTag,
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

        expect(definition.isLunoraContainer).toBe(true);
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

    it("rejects an invalid env variable name", () => {
        expect.assertions(1);

        expect(() => defineContainer({ env: { "BAD-NAME": "x" }, image: "./app" })).toThrow("env variable name");
    });

    it("rejects an invalid buildArg name", () => {
        expect.assertions(1);

        expect(() => defineContainer({ buildArgs: { "9bad": "x" }, image: "./app" })).toThrow("buildArg name");
    });

    it("rejects a name declared in both env and secrets", () => {
        expect.assertions(1);

        expect(() => defineContainer({ env: { API_KEY: "fallback" }, image: "./app", secrets: ["API_KEY"] })).toThrow("both `env` and `secrets`");
    });

    it("accepts a secretsStore env → binding map", () => {
        expect.assertions(1);

        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });

        expect(definition.secretsStore).toStrictEqual({ STRIPE_KEY: "STRIPE_SECRET" });
    });

    it("rejects an invalid secretsStore env name", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "./app", secretsStore: { "NOT-VALID": "STRIPE_SECRET" } })).toThrow("not a valid environment variable name");
    });

    it("rejects an empty secretsStore binding name", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "  " } })).toThrow("non-empty Secrets Store binding name");
    });

    it("rejects a name declared in both secretsStore and env/secrets", () => {
        expect.assertions(2);

        expect(() => defineContainer({ env: { API_KEY: "x" }, image: "./app", secretsStore: { API_KEY: "API_SECRET" } })).toThrow(
            "both `secretsStore` and `env`/`secrets`",
        );
        expect(() => defineContainer({ image: "./app", secrets: ["API_KEY"], secretsStore: { API_KEY: "API_SECRET" } })).toThrow(
            "both `secretsStore` and `env`/`secrets`",
        );
    });

    it("rejects an invalid sleepAfter string", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "./app", sleepAfter: "5 minutes" })).toThrow("`sleepAfter`");
    });

    it("rejects a non-positive, fractional, or NaN numeric sleepAfter", () => {
        expect.assertions(4);

        expect(() => defineContainer({ image: "./app", sleepAfter: 0 })).toThrow("`sleepAfter` must be a positive integer");
        expect(() => defineContainer({ image: "./app", sleepAfter: -30 })).toThrow("`sleepAfter` must be a positive integer");
        expect(() => defineContainer({ image: "./app", sleepAfter: 1.5 })).toThrow("`sleepAfter` must be a positive integer");
        expect(() => defineContainer({ image: "./app", sleepAfter: Number.NaN })).toThrow("`sleepAfter` must be a positive integer");
    });

    it("accepts a positive integer sleepAfter", () => {
        expect.assertions(1);

        expect(defineContainer({ image: "./app", sleepAfter: 30 }).sleepAfter).toBe(30);
    });

    it("accepts a Railpack { build } image source", () => {
        expect.assertions(1);

        expect(defineContainer({ image: { build: "./services/worker" } }).isLunoraContainer).toBe(true);
    });

    it("accepts buildArgs and rollout config", () => {
        expect.assertions(2);

        const definition = defineContainer({ buildArgs: { NODE_ENV: "production" }, image: "./app", rollout: { gracePeriodSeconds: 300, stepPercentage: 25 } });

        expect(definition.buildArgs).toStrictEqual({ NODE_ENV: "production" });
        expect(definition.rollout).toStrictEqual({ gracePeriodSeconds: 300, stepPercentage: 25 });
    });

    it("rejects an out-of-range rollout stepPercentage", () => {
        expect.assertions(2);

        expect(() => defineContainer({ image: "./app", rollout: { stepPercentage: 0 } })).toThrow("rollout.stepPercentage");
        expect(() => defineContainer({ image: "./app", rollout: { stepPercentage: 101 } })).toThrow("rollout.stepPercentage");
    });

    it("rejects a fractional or negative rollout gracePeriodSeconds, but accepts 0", () => {
        expect.assertions(3);

        expect(() => defineContainer({ image: "./app", rollout: { gracePeriodSeconds: -1 } })).toThrow("rollout.gracePeriodSeconds");
        expect(() => defineContainer({ image: "./app", rollout: { gracePeriodSeconds: 1.5 } })).toThrow("rollout.gracePeriodSeconds");
        // 0 is a meaningful value — no grace period — not a missing one.
        expect(defineContainer({ image: "./app", rollout: { gracePeriodSeconds: 0 } }).rollout).toStrictEqual({ gracePeriodSeconds: 0 });
    });

    it("rejects an empty { build } source", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: { build: "" } })).toThrow("`image.build` must be a non-empty");
    });

    it("accepts multi-port, egress-firewall, and labels config", () => {
        expect.assertions(7);

        const definition = defineContainer({
            allowedHosts: ["*.stripe.com"],
            deniedHosts: ["*.evil.com"],
            entrypoint: ["node", "server.js"],
            image: "./app",
            interceptHttps: true,
            labels: { env: "prod", tenant: "acme" },
            pingEndpoint: "/healthz",
            requiredPorts: [8080, 9090],
        });

        expect(definition.requiredPorts).toStrictEqual([8080, 9090]);
        expect(definition.entrypoint).toStrictEqual(["node", "server.js"]);
        expect(definition.interceptHttps).toBe(true);
        expect(definition.allowedHosts).toStrictEqual(["*.stripe.com"]);
        expect(definition.deniedHosts).toStrictEqual(["*.evil.com"]);
        expect(definition.pingEndpoint).toBe("/healthz");
        expect(definition.labels).toStrictEqual({ env: "prod", tenant: "acme" });
    });

    it("rejects a blank entrypoint part, hostname, or label key", () => {
        expect.assertions(3);

        expect(() => defineContainer({ entrypoint: ["node", "   "], image: "./app" })).toThrow("`entrypoint` must be a non-empty");
        expect(() => defineContainer({ allowedHosts: ["  "], image: "./app" })).toThrow("`allowedHosts` must be an array of non-empty");
        expect(() => defineContainer({ image: "./app", labels: { "  ": "x" } })).toThrow("`labels` must be a record of non-empty");
    });

    it("rejects a non-boolean interceptHttps", () => {
        expect.assertions(1);

        expect(() => defineContainer({ image: "./app", interceptHttps: "yes" as unknown as boolean })).toThrow("`interceptHttps` must be a boolean");
    });

    it("accepts hardTimeout and readyOn config", () => {
        expect.assertions(3);

        const definition = defineContainer({
            defaultPort: 8080,
            hardTimeout: "1h",
            image: "./app",
            readyOn: [{ path: "/ready" }, { path: "migrations", port: 9090, status: 204 }],
        });

        expect(definition.hardTimeout).toBe("1h");
        expect(definition.readyOn).toStrictEqual([{ path: "/ready" }, { path: "migrations", port: 9090, status: 204 }]);
        expect(defineContainer({ hardTimeout: 600, image: "./app" }).hardTimeout).toBe(600);
    });

    it("rejects an invalid hardTimeout", () => {
        expect.assertions(3);

        expect(() => defineContainer({ hardTimeout: "5 minutes", image: "./app" })).toThrow("`hardTimeout`");
        expect(() => defineContainer({ hardTimeout: 0, image: "./app" })).toThrow("`hardTimeout`");
        expect(() => defineContainer({ hardTimeout: -5, image: "./app" })).toThrow("`hardTimeout`");
    });

    it("rejects an invalid readyOn check", () => {
        expect.assertions(4);

        expect(() => defineContainer({ image: "./app", readyOn: [{ path: "   " }] })).toThrow("`readyOn[].path`");
        expect(() => defineContainer({ image: "./app", readyOn: [{ path: " /ready " }] })).toThrow("leading or trailing whitespace");
        expect(() => defineContainer({ image: "./app", readyOn: [{ path: "/ready", port: 70_000 }] })).toThrow("readyOn[].port");
        expect(() => defineContainer({ image: "./app", readyOn: [{ path: "/ready", status: 700 }] })).toThrow("`readyOn[].status`");
    });

    it("rejects an empty or out-of-range requiredPorts", () => {
        expect.assertions(2);

        expect(() => defineContainer({ image: "./app", requiredPorts: [] })).toThrow("`requiredPorts` must be a non-empty");
        expect(() => defineContainer({ image: "./app", requiredPorts: [70_000] })).toThrow("requiredPorts[]");
    });

    it("rejects an empty entrypoint and an empty-string entrypoint part", () => {
        expect.assertions(2);

        expect(() => defineContainer({ entrypoint: [], image: "./app" })).toThrow("`entrypoint` must be a non-empty");
        expect(() => defineContainer({ entrypoint: ["node", ""], image: "./app" })).toThrow("`entrypoint` must be a non-empty");
    });

    it("rejects an empty hostname in an egress list and an empty pingEndpoint", () => {
        expect.assertions(3);

        expect(() => defineContainer({ allowedHosts: [""], image: "./app" })).toThrow("`allowedHosts` must be an array of non-empty");
        expect(() => defineContainer({ deniedHosts: [""], image: "./app" })).toThrow("`deniedHosts` must be an array of non-empty");
        expect(() => defineContainer({ image: "./app", pingEndpoint: "" })).toThrow("`pingEndpoint` must be a non-empty");
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

describe(containerBuildTag, () => {
    it("derives the deterministic Railpack build tag", () => {
        expect.assertions(2);

        expect(containerBuildTag("transcoder")).toBe("lunora-transcoder:build");
        expect(containerBuildTag("imageResizer")).toBe("lunora-image-resizer:build");
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
