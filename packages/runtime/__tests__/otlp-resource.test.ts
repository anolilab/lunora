import { describe, expect, it } from "vitest";

import { detectCloudflareResource, detectHostResource, detectServiceResource, mergeResourceAttributes, readerFromRecord } from "../../../shared/otlp-resource";
import { createResourceAttributeResolver } from "../src/resource-detect";

describe("shared/otlp-resource", () => {
    describe("readerFromRecord", () => {
        it("reads string values and treats everything else as absent", () => {
            expect.assertions(4);

            // A Worker's `env` holds KV namespaces, secrets stores and other
            // non-string bindings alongside plain vars; only real strings are vars.
            const read = readerFromRecord({ BINDING: { get: () => undefined }, EMPTY: "", NUMERIC: 3, VERSION: "v1" });

            expect(read("VERSION")).toBe("v1");
            expect(read("BINDING")).toBeUndefined();
            expect(read("NUMERIC")).toBeUndefined();
            expect(read("EMPTY")).toBeUndefined();
        });

        it("tolerates an absent environment", () => {
            expect.assertions(1);

            expect(readerFromRecord(undefined)("VERSION")).toBeUndefined();
        });
    });

    describe("detectServiceResource", () => {
        it("prefers an explicit SERVICE_VERSION over platform-injected shas", () => {
            expect.assertions(1);

            const attributes = detectServiceResource(readerFromRecord({ GITHUB_SHA: "sha", SERVICE_VERSION: "v1.2.3", VERCEL_GIT_COMMIT_SHA: "vercel" }));

            expect(attributes["service.version"]).toBe("v1.2.3");
        });

        it.each([["CF_VERSION_METADATA"], ["VERCEL_GIT_COMMIT_SHA"], ["GITHUB_SHA"], ["COMMIT_SHA"]])("falls back to %s", (key) => {
            expect.assertions(1);

            expect(detectServiceResource(readerFromRecord({ [key]: "abc123" }))["service.version"]).toBe("abc123");
        });

        it.each([["DEPLOYMENT_ENVIRONMENT"], ["ENVIRONMENT"], ["NODE_ENV"]])("reads deployment.environment from %s", (key) => {
            expect.assertions(1);

            expect(detectServiceResource(readerFromRecord({ [key]: "production" }))["deployment.environment"]).toBe("production");
        });

        it("omits attributes it cannot determine rather than guessing", () => {
            expect.assertions(1);

            expect(detectServiceResource(readerFromRecord({}))).toStrictEqual({});
        });
    });

    describe("detectHostResource", () => {
        it("reports host.name and the pid the caller supplies", () => {
            expect.assertions(2);

            const attributes = detectHostResource(readerFromRecord({ HOSTNAME: "box-1" }), 42);

            expect(attributes["host.name"]).toBe("box-1");
            expect(attributes["process.pid"]).toBe(42);
        });

        // HOSTNAME is the pod name only under Kubernetes; elsewhere it is just the
        // machine name, which is already reported as host.name.
        it("only reports k8s.pod.name when actually running under Kubernetes", () => {
            expect.assertions(2);

            expect(detectHostResource(readerFromRecord({ HOSTNAME: "box-1" }))["k8s.pod.name"]).toBeUndefined();
            expect(detectHostResource(readerFromRecord({ HOSTNAME: "pod-1", KUBERNETES_SERVICE_HOST: "kubernetes.default.svc" }))["k8s.pod.name"]).toBe(
                "pod-1",
            );
        });

        it("omits process.pid when the host has none", () => {
            expect.assertions(1);

            expect(detectHostResource(readerFromRecord({}))["process.pid"]).toBeUndefined();
        });
    });

    describe("detectCloudflareResource", () => {
        it("returns nothing when there is no sign of Cloudflare", () => {
            expect.assertions(1);

            expect(detectCloudflareResource(readerFromRecord({}))).toStrictEqual({});
        });

        it("reads the colo off the request's cf bag", () => {
            expect.assertions(2);

            const attributes = detectCloudflareResource(readerFromRecord({}), { colo: "SFO" });

            expect(attributes["cloud.provider"]).toBe("cloudflare");
            expect(attributes["cloud.region"]).toBe("SFO");
        });

        it("falls back to env for request-less paths such as crons", () => {
            expect.assertions(1);

            expect(detectCloudflareResource(readerFromRecord({ CF_ACCOUNT_ID: "abc", CF_COLO: "LHR" }))["cloud.region"]).toBe("LHR");
        });

        it("ignores a cf bag whose colo is not a string", () => {
            expect.assertions(2);

            const attributes = detectCloudflareResource(readerFromRecord({}), { colo: 42 });

            expect(attributes["cloud.provider"]).toBe("cloudflare");
            expect(attributes["cloud.region"]).toBeUndefined();
        });
    });

    describe("mergeResourceAttributes", () => {
        it("lets later bags win, which is what puts explicit config above detection", () => {
            expect.assertions(2);

            const merged = mergeResourceAttributes({ "cloud.region": "detected", "service.version": "v1" }, { "cloud.region": "explicit" });

            expect(merged["cloud.region"]).toBe("explicit");
            expect(merged["service.version"]).toBe("v1");
        });

        it("skips absent bags and never aliases an input", () => {
            expect.assertions(2);

            const source = { "service.version": "v1" };
            const merged = mergeResourceAttributes(undefined, source, undefined);

            expect(merged).toStrictEqual(source);
            expect(merged).not.toBe(source);
        });
    });
});

describe("createResourceAttributeResolver", () => {
    it("composes only the detectors a Worker can satisfy", () => {
        expect.assertions(2);

        // `HOSTNAME` would be a container/Kubernetes signal; a Worker's `env` is a
        // bindings bag, so probing for it here would be a dead branch.
        const request = new Request("https://api.example.com/_lunora/rpc");
        Object.defineProperty(request, "cf", { value: { colo: "SFO" }, writable: false });

        const attributes = createResourceAttributeResolver({ HOSTNAME: "box-1", SERVICE_VERSION: "v1.2.3" }, request)();

        expect(attributes).toStrictEqual({ "cloud.provider": "cloudflare", "cloud.region": "SFO", "service.version": "v1.2.3" });
        expect(attributes["host.name"]).toBeUndefined();
    });

    // Detection is a per-request constant, and this runs behind every log line,
    // metric and span — so it must resolve at most once.
    it("memoizes so repeated reads cost nothing", () => {
        expect.assertions(1);

        const resolve = createResourceAttributeResolver({ SERVICE_VERSION: "v1" }, new Request("https://api.example.com/"));

        expect(resolve()).toBe(resolve());
    });

    it("works with no env and no request", () => {
        expect.assertions(1);

        expect(createResourceAttributeResolver(undefined)()).toStrictEqual({});
    });
});
