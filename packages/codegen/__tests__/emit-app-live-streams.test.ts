import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import type { LiveStreamIR } from "../src/ir";
import baseOptions from "./emit-app-options";

const posts: LiveStreamIR = { exportName: "posts", filePath: "live", id: "posts", topics: [] };

describe("emitApp — live stream routes", () => {
    it("mounts each declared stream on the worker's router, ahead of the app's own router", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, liveStreamDeclarations: [posts], liveStreams: true });

        expect(output).toContain('import { liveStreamRouter } from "@lunora/server";');
        expect(output).toContain('{ id: "posts", load: () => import("../live.js").then((m) => m.posts) },');
        expect(output).toContain("], this.httpRouterApp),");
    });

    it("imports the server from the umbrella package when the app uses it", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, liveStreamDeclarations: [posts], liveStreams: true, useUmbrella: true });

        expect(output).toContain('import { liveStreamRouter } from "lunorash/server";');
    });

    it("leaves the worker's router as the app's own when the target withholds live streams", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, liveStreamDeclarations: [posts], liveStreams: false, liveStreamsWithheld: true });

        expect(output).not.toContain("liveStreamRouter");
        expect(output).toContain("...(this.httpRouterApp ? { httpRouter: this.httpRouterApp } : {}),");
    });

    it("leaves the worker's router as the app's own when the app declares no stream", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, liveStreamDeclarations: [], liveStreams: true });

        expect(output).not.toContain("liveStreamRouter");
        expect(output).toContain("...(this.httpRouterApp ? { httpRouter: this.httpRouterApp } : {}),");
    });

    it("wraps a framework host with the live-stream routes, so /live/... never reaches the host unmounted", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasFramework: true, liveStreamDeclarations: [posts], liveStreams: true });

        expect(output).toContain("withFrameworkWorker(liveStreamRouter([");
        expect(output).toContain("], host), (hostEnv) =>");
    });

    it("hands a framework host over unwrapped when the app declares no stream", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasFramework: true, liveStreamDeclarations: [], liveStreams: true });

        expect(output).toContain("withFrameworkWorker(host, (hostEnv) =>");
    });

    it("refuses a stream whose file path is not safe to import", () => {
        expect.assertions(1);

        expect(() => emitApp({ ...baseOptions, liveStreamDeclarations: [{ ...posts, filePath: 'live") + (1' }], liveStreams: true })).toThrow(
            /not safe to import/u,
        );
    });
});
