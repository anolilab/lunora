import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createStudioMiddleware, isNonLoopbackHost, requestPathname, STUDIO_PATH, studioMountPath } from "../../src/studio-host/middleware";

/**
 * The prebuilt `@lunora/studio` bundle, stood in so the asset routes are tested
 * against a known bundle rather than whatever the workspace last built.
 */
const assets = vi.hoisted(() => {
    return { available: true, chunks: new Map([["studio.js", "console.log('studio');"]]) };
});

vi.mock(import("../../src/studio-host/assets"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        loadStudioAssets: () => (assets.available ? { script: Buffer.from("studio"), styles: Buffer.from(".studio{}") } : undefined),
        readStandaloneAsset: (fileName: string) => {
            const chunk = assets.chunks.get(fileName);

            return chunk === undefined ? undefined : Buffer.from(chunk);
        },
        studioAssetsStamp: () => 1,
    };
});

/* eslint-disable sonarjs/no-hardcoded-ip -- loopback/LAN fixtures for the bind and transport checks; no real connection is made */

const roots: string[] = [];

const projectRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lunora-studio-mw-"));

    roots.push(root);

    return root;
};

const request = (url: string, remoteAddress = "127.0.0.1", extra: { headers?: Record<string, string>; method?: string } = {}): IncomingMessage =>
    ({ headers: { host: "localhost:3000", ...extra.headers }, method: extra.method ?? "GET", socket: { remoteAddress }, url }) as unknown as IncomingMessage;

interface CapturedResponse {
    body: () => string;
    response: ServerResponse;
    status: () => number;
}

const capture = (): CapturedResponse => {
    let body = "";
    const response = {
        end: (chunk?: Buffer | string) => {
            body = chunk === undefined ? "" : String(chunk);
        },
        setHeader: () => response,
        statusCode: 0,
    };

    return { body: () => body, response: response as unknown as ServerResponse, status: () => response.statusCode };
};

describe(createStudioMiddleware, () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("passes everything outside the mount through to the host", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const next = vi.fn<() => void>();
        const { response } = capture();

        middleware(request("/"), response, next);
        middleware(request("/__lunoraish"), response, next);

        // `/__lunoraish` shares the prefix but is not under the mount.
        expect(next).toHaveBeenCalledTimes(2);
        expect(STUDIO_PATH).toBe("/__lunora");
    });

    it("answers a deep link under the mount with the studio document", () => {
        expect.assertions(3);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const next = vi.fn<() => void>();
        const captured = capture();

        middleware(request("/__lunora/data?table=messages"), captured.response, next);

        expect(next).not.toHaveBeenCalled();
        expect(captured.status()).toBe(200);
        expect(captured.body()).toContain("/__lunora/studio.js");
    });

    it("matches the mount under a non-root base, as the dev server announces it", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ base: "/app/", isNonLoopbackBind: false, projectRoot: projectRoot() });
        const next = vi.fn<() => void>();
        const captured = capture();

        middleware(request("/app/__lunora"), captured.response, next);

        expect(next).not.toHaveBeenCalled();
        expect(captured.status()).toBe(200);
    });

    it("refuses on a non-loopback bind even for a loopback browser", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: true, projectRoot: projectRoot() });
        const captured = capture();

        middleware(request("/__lunora"), captured.response, vi.fn<() => void>());

        // The document embeds the admin token.
        expect(captured.status()).toBe(403);
        expect(captured.body()).not.toContain("studio.js");
    });

    it("refuses a non-loopback peer whatever the bind says", () => {
        expect.assertions(1);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const captured = capture();

        // Rsbuild binds `0.0.0.0` by default, so a LAN peer can reach the socket.
        middleware(request("/__lunora", "192.168.1.20"), captured.response, vi.fn<() => void>());

        expect(captured.status()).toBe(403);
    });
});

describe("createStudioMiddleware assets and endpoints", () => {
    afterEach(() => {
        assets.available = true;

        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("serves the stylesheet and the studio entry", () => {
        expect.assertions(4);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const styles = capture();
        const script = capture();

        middleware(request("/__lunora/styles.css"), styles.response, vi.fn<() => void>());
        middleware(request("/__lunora/studio.js"), script.response, vi.fn<() => void>());

        expect(styles.status()).toBe(200);
        expect(styles.body()).toBe(".studio{}");
        expect(script.status()).toBe(200);
        expect(script.body()).toContain("studio");
    });

    it("404s an unknown module instead of handing it the HTML document", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const captured = capture();

        middleware(request("/__lunora/chunk-gone.js"), captured.response, vi.fn<() => void>());

        expect(captured.status()).toBe(404);
        expect(captured.body()).not.toContain("<html");
    });

    it("answers a matching ETag with 304", () => {
        expect.assertions(1);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const captured = capture();

        middleware(request("/__lunora/styles.css", "127.0.0.1", { headers: { "if-none-match": 'W/"styles.css-1"' } }), captured.response, vi.fn<() => void>());

        expect(captured.status()).toBe(304);
    });

    it("says so when @lunora/studio is not installed", () => {
        expect.assertions(2);

        assets.available = false;

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const captured = capture();

        middleware(request("/__lunora/styles.css"), captured.response, vi.fn<() => void>());

        expect(captured.status()).toBe(501);
        expect(captured.body()).toContain("@lunora/studio");
    });

    it("routes a local endpoint to its JSON handler, CSRF gate first", () => {
        expect.assertions(2);

        const middleware = createStudioMiddleware({ isNonLoopbackBind: false, projectRoot: projectRoot() });
        const captured = capture();

        // A cross-site POST: refused as JSON by the endpoint's own gate, never
        // answered with the studio document.
        middleware(
            request("/__lunora/seed", "127.0.0.1", { headers: { "sec-fetch-site": "cross-site" }, method: "POST" }),
            captured.response,
            vi.fn<() => void>(),
        );

        expect(captured.status()).toBe(403);
        expect(captured.body()).toContain("cross-origin");
    });
});

describe(isNonLoopbackHost, () => {
    it("treats an unset host as the bundler's default, not an intent to expose", () => {
        expect.assertions(4);

        expect(isNonLoopbackHost(undefined)).toBe(false);
        expect(isNonLoopbackHost(false)).toBe(false);
        expect(isNonLoopbackHost("localhost")).toBe(false);
        expect(isNonLoopbackHost("127.0.0.1")).toBe(false);
    });

    it("flags `--host` and explicit non-loopback addresses", () => {
        expect.assertions(3);

        expect(isNonLoopbackHost(true)).toBe(true);
        expect(isNonLoopbackHost("0.0.0.0")).toBe(true);
        expect(isNonLoopbackHost("192.168.1.20")).toBe(true);
    });
});

describe(studioMountPath, () => {
    it("moves the mount with the base", () => {
        expect.assertions(4);

        expect(studioMountPath()).toBe("/__lunora");
        expect(studioMountPath("/")).toBe("/__lunora");
        expect(studioMountPath("/app/")).toBe("/app/__lunora");
        expect(studioMountPath("/app")).toBe("/app/__lunora");
    });
});

describe(requestPathname, () => {
    it("drops the query and keeps the root and trailing slashes", () => {
        expect.assertions(3);

        // `lunora dev` routes its studio at `/`, so the root must stay `/`.
        expect(requestPathname("/")).toBe("/");
        expect(requestPathname("/__lunora/?tab=data")).toBe("/__lunora/");
        expect(requestPathname("/_lunora/rpc?x=1")).toBe("/_lunora/rpc");
    });

    it("routes a dot-segment path as the path it resolves to", () => {
        expect.assertions(1);

        // Not a `/_lunora` path, so a host must not proxy it as one.
        expect(requestPathname("/_lunora/../__admin")).toBe("/__admin");
    });
});
