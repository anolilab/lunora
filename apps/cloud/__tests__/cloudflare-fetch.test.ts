import { describe, expect, it, vi } from "vitest";

import { cloudflareFetch, CloudflareTokenError } from "../src/cloudflare/fetch";

const TOKEN = "tok_secret_value";

const answering = (response: Response) => vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);

describe(cloudflareFetch, () => {
    it("sends the bearer token and a JSON body to the API root, and answers the envelope's payload", async () => {
        const fetch = answering(Response.json({ result: [{ id: "r1" }], result_info: { total_pages: 3 }, success: true }));
        const call = cloudflareFetch({ apiToken: TOKEN, baseUrl: "https://api.test/client/v4/", fetch });

        await expect(call("/zones/z/dns_records", { body: { name: "a" }, method: "POST" })).resolves.toStrictEqual({ result: [{ id: "r1" }], totalPages: 3 });

        const [url, init] = fetch.mock.calls[0] ?? [];

        expect(url).toBe("https://api.test/client/v4/zones/z/dns_records");
        expect(init).toMatchObject({ body: JSON.stringify({ name: "a" }), method: "POST" });
        expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("answers one page when the envelope carries no result_info, and an absent result as undefined", async () => {
        const call = cloudflareFetch({ apiToken: TOKEN, fetch: answering(Response.json({ success: true })) });

        await expect(call("/zones/z/dns_records/r1", { method: "DELETE" })).resolves.toStrictEqual({ result: undefined, totalPages: 1 });
    });

    it("answers null for a 404 only when the request allows one", async () => {
        const missing = (): Response => Response.json({ errors: [{ message: "not found" }], success: false }, { status: 404 });

        await expect(cloudflareFetch({ apiToken: TOKEN, fetch: answering(missing()) })("/zones/z/custom_hostnames/h", { allow404: true })).resolves.toBeNull();
        await expect(cloudflareFetch({ apiToken: TOKEN, fetch: answering(missing()) })("/zones/z/custom_hostnames/h")).rejects.toThrow(
            "Cloudflare GET /zones/z/custom_hostnames/h failed: not found",
        );
    });

    it("throws CloudflareTokenError for a refused token, without the token or the query in the message", async () => {
        const fetch = answering(Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status: 403 }));
        const failure = await cloudflareFetch({ apiToken: TOKEN, fetch })("/accounts/a/workers/scripts?per_page=1").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CloudflareTokenError);
        expect((failure as Error).message).toBe("Cloudflare refused the token for GET /accounts/a/workers/scripts: Authentication error");
        expect((failure as Error).message).not.toContain(TOKEN);
    });

    it("throws a plain Error for success: false on a 200, and names the status when Cloudflare gives no reason", async () => {
        await expect(
            cloudflareFetch({ apiToken: TOKEN, fetch: answering(Response.json({ errors: [{ message: "nope" }], success: false })) })("/x"),
        ).rejects.toThrow("Cloudflare GET /x failed: nope");

        const bare = await cloudflareFetch({ apiToken: TOKEN, fetch: answering(new Response("upstream", { status: 502 })) })("/x").catch(
            (error: unknown) => error,
        );

        expect(bare).not.toBeInstanceOf(CloudflareTokenError);
        expect((bare as Error).message).toBe("Cloudflare GET /x failed: HTTP 502");
    });
});
