import { describe, expect, it, vi } from "vitest";

import { checkArtifactsJurisdiction } from "../../src/util/artifacts-jurisdiction";

const credentials = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token" };

/** The GET namespace answer, in the v4 envelope, with `jurisdiction`. */
const namespaceApi = (jurisdiction: string) =>
    vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
            errors: [],
            messages: [],
            result: { created_at: "2026-10-01T00:00:00Z", jurisdiction, namespace: "repos", repo_count: 2, updated_at: "2026-10-01T00:00:00Z" },
            success: true,
        }),
    );

const check = async (
    fetchImpl: typeof globalThis.fetch,
    jurisdiction: "eu" | "fedramp" | "us" = "eu",
    environment: Record<string, string> = credentials,
    create = false,
) => checkArtifactsJurisdiction({ binding: "ARTIFACTS", create, environment, fetch: fetchImpl, jurisdiction, namespace: "repos" });

describe(checkArtifactsJurisdiction, () => {
    it("reads the namespace from the account-scoped endpoint with the bearer token", async () => {
        expect.assertions(2);

        const fetchImpl = namespaceApi("eu");

        await check(fetchImpl);

        const [url, init] = fetchImpl.mock.calls[0] ?? [];

        expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/artifacts/namespaces/repos");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
    });

    it.each([
        ["eu", "eu", "ok"],
        ["us", "us", "ok"],
        ["fedramp", "fedramp", "ok"],
        ["eu", "us", "mismatch"],
        ["us", "eu", "mismatch"],
        ["eu", "fedramp", "mismatch"],
        ["eu", "unrestricted", "mismatch"],
        ["us", "unrestricted", "mismatch"],
    ] as const)("schema %s + namespace %s is %s", async (declared, actual, verdict) => {
        expect.assertions(1);

        await expect(check(namespaceApi(actual), declared)).resolves.toMatchObject({ verdict });
    });

    it("names both jurisdictions on a mismatch and says the namespace has to be recreated", async () => {
        expect.assertions(2);

        const result = await check(namespaceApi("unrestricted"));

        expect(result.message).toBe('Artifacts namespace "repos" (binding ARTIFACTS) is in the "unrestricted" jurisdiction, but the schema pins data to "eu".');
        expect(result.fix).toContain(
            'cannot change: create one with POST https://api.cloudflare.com/client/v4/accounts/acc/artifacts/namespaces with body { "namespace": "<name>", "jurisdiction": "eu" }',
        );
    });

    it("reports a namespace that does not exist yet with the create call to run first", async () => {
        expect.assertions(1);

        const absent = vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 }),
        );

        await expect(check(absent)).resolves.toMatchObject({
            fix: 'Create it before the first repo: POST https://api.cloudflare.com/client/v4/accounts/acc/artifacts/namespaces with body { "namespace": "repos", "jurisdiction": "eu" }.',
            verdict: "missing",
        });
    });

    it("accepts a namespace whose creation response was lost, once a second look shows the right jurisdiction", async () => {
        expect.assertions(2);

        let created = false;
        const api = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
            if (init?.method === "POST") {
                created = true;

                throw new TypeError("socket hang up");
            }

            return created
                ? Response.json({ result: { jurisdiction: "eu", namespace: "repos" }, success: true })
                : Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 });
        });

        await expect(check(api, "eu", credentials, true)).resolves.toMatchObject({ verdict: "ok" });
        expect(api).toHaveBeenCalledTimes(3);
    });

    it("reports a mismatch, not a missing namespace, when the second look finds one in another jurisdiction", async () => {
        expect.assertions(2);

        let reads = 0;
        const api = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
            if (init?.method === "POST") {
                return Response.json({ errors: [{ code: 1, message: "conflict" }], success: false }, { status: 409 });
            }

            reads += 1;

            return reads > 1
                ? Response.json({ result: { jurisdiction: "unrestricted", namespace: "repos" }, success: true })
                : Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 });
        });
        const result = await check(api, "eu", credentials, true);

        expect(result.verdict).toBe("mismatch");
        expect(result.message).toContain('is in the "unrestricted" jurisdiction');
    });

    it("says why the creation was refused when the namespace is still not there", async () => {
        expect.assertions(2);

        const api = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
            init?.method === "POST"
                ? Response.json({ errors: [{ code: 10_000, message: "token lacks Artifacts: Edit" }], success: false }, { status: 403 })
                : Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 }),
        );
        const result = await check(api, "eu", credentials, true);

        expect(result.verdict).toBe("missing");
        expect(result.message).toContain("could not be created (HTTP 403: token lacks Artifacts: Edit)");
    });

    it("still reports a missing namespace when the second look cannot find it either", async () => {
        expect.assertions(1);

        const api = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
            init?.method === "POST"
                ? Response.json({ errors: [{ code: 1, message: "denied" }], success: false }, { status: 403 })
                : Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 }),
        );

        await expect(check(api, "eu", credentials, true)).resolves.toMatchObject({ verdict: "missing" });
    });

    it("lets a missing namespace pass when a later step will create it, and still refuses a wrong jurisdiction", async () => {
        expect.assertions(3);

        const absent = vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 }),
        );
        const result = await checkArtifactsJurisdiction({
            binding: "ARTIFACTS",
            environment: credentials,
            fetch: absent,
            jurisdiction: "eu",
            missingOk: true,
            namespace: "repos",
        });

        expect(result.verdict).toBe("ok");
        expect(absent.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        await expect(
            checkArtifactsJurisdiction({
                binding: "ARTIFACTS",
                environment: credentials,
                fetch: namespaceApi("unrestricted"),
                jurisdiction: "eu",
                missingOk: true,
                namespace: "repos",
            }),
        ).resolves.toMatchObject({ verdict: "mismatch" });
    });

    it("creates nothing unless asked to, so doctor and a dry run stay read-only", async () => {
        expect.assertions(2);

        const api = vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 }),
        );

        await expect(check(api)).resolves.toMatchObject({ message: expect.stringContaining("does not exist, and the first repo"), verdict: "missing" });
        expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });

    it("creates a missing namespace in the schema's jurisdiction before any repo can make it unrestricted", async () => {
        expect.assertions(4);

        const api = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
            init?.method === "POST"
                ? Response.json({ errors: [], result: { jurisdiction: "eu", namespace: "repos" }, success: true })
                : Response.json({ errors: [{ code: 404, message: "not found" }], success: false }, { status: 404 }),
        );

        await expect(check(api, "eu", credentials, true)).resolves.toMatchObject({ verdict: "ok" });

        const post = api.mock.calls.find(([, init]) => init?.method === "POST");

        expect(api).toHaveBeenCalledTimes(2);
        expect(post?.[0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc/artifacts/namespaces");
        expect(post?.[1]?.body).toBe(JSON.stringify({ jurisdiction: "eu", namespace: "repos" }));
    });

    it("does not call the API without credentials, and says how to enable the check", async () => {
        expect.assertions(3);

        const fetchImpl = namespaceApi("eu");
        const result = await check(fetchImpl, "eu", {});

        expect(result.verdict).toBe("unchecked");
        expect(result.fix).toContain("CLOUDFLARE_API_TOKEN (with Artifacts read access)");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([401, 403])("names the missing token scope on HTTP %i", async (status) => {
        expect.assertions(1);

        const refused = vi.fn<typeof globalThis.fetch>(async () =>
            Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status }),
        );

        await expect(check(refused)).resolves.toStrictEqual({
            fix: "Give CLOUDFLARE_API_TOKEN Artifacts read access on account acc.",
            message: `the jurisdiction of Artifacts namespace "repos" (binding ARTIFACTS) could not be read (HTTP ${String(status)}).`,
            verdict: "unchecked",
        });
    });

    it("leaves a server error, a network failure and a body without a jurisdiction unchecked", async () => {
        expect.assertions(3);

        const down = vi.fn<typeof globalThis.fetch>(async () => new Response("<html>bad gateway</html>", { status: 502 }));
        const offline = vi.fn<typeof globalThis.fetch>(async () => {
            throw new TypeError("fetch failed");
        });
        const bare = vi.fn<typeof globalThis.fetch>(async () => Response.json({ result: { namespace: "repos" }, success: true }));

        await expect(check(down)).resolves.toMatchObject({ verdict: "unchecked" });
        await expect(check(offline)).resolves.toMatchObject({ message: expect.stringContaining("fetch failed"), verdict: "unchecked" });
        await expect(check(bare)).resolves.toMatchObject({ verdict: "unchecked" });
    });
});
