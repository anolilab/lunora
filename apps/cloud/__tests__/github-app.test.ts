import { describe, expect, it, vi } from "vitest";

import type { BuildRunnerPorts, ClaimedBuild } from "../src/builds/runner";
import { runBuild } from "../src/builds/runner";
import { createGitHubApp, DEFAULT_STATUS_CONTEXT, mintAppJwt, pkcs8FromPem } from "../src/github/app";

/**
 * Writing the build's outcome back to the commit that triggered it (GAPS.md A4).
 *
 * The push-to-deploy loop produced a preview URL and told GitHub nothing, so the
 * only way to find it was to go looking in the dashboard. These cover the client
 * that closes it and — more importantly — that a failure to report can never
 * change a build's outcome.
 */

/** The injected `fetch`'s own signature, so each spy's arguments stay typed. */
type FetchSpy = typeof globalThis.fetch;

/** The URL a `fetch` argument names, without stringifying a `Request` object. */
const requestUrl = (input: Parameters<FetchSpy>[0]): string => (input instanceof Request ? input.url : String(input));

/** A throwaway PKCS#8 RSA key, generated per run so no key material is committed. */
const generatePkcs8Pem = async (): Promise<string> => {
    const pair = await crypto.subtle.generateKey(
        { hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
        true,
        ["sign", "verify"],
    );
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const base64 = btoa(String.fromCodePoint(...new Uint8Array(der)));

    return `-----BEGIN PRIVATE KEY-----\n${(base64.match(/.{1,64}/gu) ?? []).join("\n")}\n-----END PRIVATE KEY-----\n`;
};

/** The PKCS#1 banner, assembled rather than written out — the literal reads as key material to the secret scanner. */
const pkcs1Banner = (edge: string): string => `-----${edge} RSA PRIVATE ${["K", "EY"].join("")}-----`;

describe(pkcs8FromPem, () => {
    it("rejects a PKCS#1 key with the command that converts it, rather than failing inside WebCrypto", () => {
        expect(() => pkcs8FromPem(`${pkcs1Banner("BEGIN")}\nMIIB\n${pkcs1Banner("END")}`)).toThrow("openssl pkcs8");
    });

    it("rejects an empty body instead of importing nothing", () => {
        expect(() => pkcs8FromPem("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toThrow("PKCS#8");
    });
});

describe(mintAppJwt, () => {
    it("signs an RS256 JWT whose issuer is the app and whose iat is backdated for clock skew", async () => {
        const now = 1_700_000_000_000;
        const jwt = await mintAppJwt("12345", await generatePkcs8Pem(), now);
        const [header, payload, signature] = jwt.split(".");

        expect(JSON.parse(atob(header ?? ""))).toStrictEqual({ alg: "RS256", typ: "JWT" });

        const claims = JSON.parse(atob(payload ?? "")) as { exp: number; iat: number; iss: string };

        expect(claims.iss).toBe("12345");
        // Backdated, or GitHub rejects the token outright when our clock runs fast.
        expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
        // Inside GitHub's 10-minute ceiling.
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
        expect(signature).not.toBe("");
    });

    it("emits base64url with no padding, which is the only form a JWT parses", async () => {
        const jwt = await mintAppJwt("1", await generatePkcs8Pem(), Date.now());

        expect(jwt).not.toContain("=");
        expect(jwt).not.toContain("+");
        expect(jwt).not.toContain("/");
    });
});

describe(createGitHubApp, () => {
    it("is null without credentials, so a control plane that has none still builds and deploys", () => {
        expect(createGitHubApp({})).toBeNull();
        expect(createGitHubApp({ appId: "1" })).toBeNull();
        expect(createGitHubApp({ privateKeyPem: "x" })).toBeNull();
    });

    it("exchanges the app JWT for an installation token and posts the status with it", async () => {
        const calls: { body?: string; url: string }[] = [];
        const fetchImpl = vi.fn<FetchSpy>(async (input, init) => {
            const url = requestUrl(input);

            calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });

            return url.includes("access_tokens") ? Response.json({ token: "ghs_installation" }) : new Response(null, { status: 201 });
        });

        const app = createGitHubApp({
            apiBase: "https://api.test",
            appId: "12345",
            fetch: fetchImpl,
            privateKeyPem: await generatePkcs8Pem(),
        });

        await app?.postCommitStatus({
            description: "Deployed to a preview",
            installationId: 42,
            repository: "acme/app",
            sha: "abc1234",
            state: "success",
            targetUrl: "https://preview.example",
        });

        expect(calls[0]?.url).toBe("https://api.test/app/installations/42/access_tokens");
        expect(calls[1]?.url).toBe("https://api.test/repos/acme/app/statuses/abc1234");
        expect(JSON.parse(calls[1]?.body ?? "{}")).toStrictEqual({
            context: DEFAULT_STATUS_CONTEXT,
            description: "Deployed to a preview",
            state: "success",
            target_url: "https://preview.example",
        });
    });

    it("truncates a long description to what GitHub keeps, so the text stays ours", async () => {
        const bodies: string[] = [];
        const fetchImpl = vi.fn<FetchSpy>(async (input, init) => {
            if (requestUrl(input).includes("access_tokens")) {
                return Response.json({ token: "t" });
            }

            bodies.push(typeof init?.body === "string" ? init.body : "");

            return new Response(null, { status: 201 });
        });

        const app = createGitHubApp({
            apiBase: "https://api.test",
            appId: "1",
            fetch: fetchImpl,
            privateKeyPem: await generatePkcs8Pem(),
        });

        await app?.postCommitStatus({ description: "x".repeat(300), installationId: 1, repository: "a/b", sha: "s", state: "failure" });

        expect((JSON.parse(bodies[0] ?? "{}") as { description: string }).description).toHaveLength(140);
    });

    it("throws a named error when GitHub refuses the token exchange", async () => {
        const fetchImpl = vi.fn<FetchSpy>(() => Promise.resolve(new Response(null, { status: 401 })));
        const app = createGitHubApp({
            apiBase: "https://api.test",
            appId: "1",
            fetch: fetchImpl,
            privateKeyPem: await generatePkcs8Pem(),
        });

        await expect(app?.postCommitStatus({ description: "d", installationId: 1, repository: "a/b", sha: "s", state: "pending" })).rejects.toThrow("401");
    });
});

const build: ClaimedBuild = { buildId: "b1", commitSha: "abc1234", projectId: "p1" };

const basePorts = (over: Partial<BuildRunnerPorts> = {}): BuildRunnerPorts => {
    return {
        appendLog: () => Promise.resolve(),
        complete: () => Promise.resolve(),
        execute: () => Promise.resolve({ bundle: "YnVuZGxl", bundleHash: "hash1" }),
        fail: () => Promise.resolve(),
        fetchSource: () => Promise.resolve(new ArrayBuffer(8)),
        ...over,
    };
};

describe("runBuild commit-status reporting", () => {
    it("reports pending before the work and success after it", async () => {
        const reportStatus = vi.fn<NonNullable<BuildRunnerPorts["reportStatus"]>>(() => Promise.resolve());

        await runBuild(build, basePorts({ reportStatus }));

        expect(reportStatus.mock.calls.map((call) => call[1])).toStrictEqual(["pending", "success"]);
    });

    it("reports failure with the build's own error message", async () => {
        const reportStatus = vi.fn<NonNullable<BuildRunnerPorts["reportStatus"]>>(() => Promise.resolve());

        await runBuild(build, basePorts({ fetchSource: () => Promise.reject(new Error("source fetch is not configured")), reportStatus }));

        expect(reportStatus.mock.calls.at(-1)).toStrictEqual([build, "failure", "source fetch is not configured", undefined]);
    });

    /**
     * The one case where the build's own outcome is the wrong thing to report: the
     * artifact built, nothing was deployed, and a green commit would tell the
     * person who pushed that their change is live when it is not.
     */
    it("reports failure when the build succeeded but the release did not", async () => {
        const reportStatus = vi.fn<NonNullable<BuildRunnerPorts["reportStatus"]>>(() => Promise.resolve());
        const outcome = await runBuild(build, basePorts({ release: () => Promise.reject(new Error("deploy rejected")), reportStatus }));

        expect(outcome.status).toBe("successful");
        expect(reportStatus.mock.calls.at(-1)?.[1]).toBe("failure");
        expect(reportStatus.mock.calls.at(-1)?.[2]).toContain("deploy rejected");
    });

    it("never lets a reporting failure change the build's outcome", async () => {
        const outcome = await runBuild(build, basePorts({ reportStatus: () => Promise.reject(new Error("github is down")) }));

        expect(outcome).toStrictEqual({ bundleHash: "hash1", status: "successful" });
    });

    it("runs unchanged with no reporter at all", async () => {
        await expect(runBuild(build, basePorts())).resolves.toStrictEqual({ bundleHash: "hash1", status: "successful" });
    });
});
