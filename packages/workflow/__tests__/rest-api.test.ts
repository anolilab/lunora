import { describe, expect, it } from "vitest";

import { createWorkflowsRestClient, WorkflowsRestError } from "../src/rest-api";

/** Stringify a `fetch` input (the client always passes a string; the rest is for the signature). */
const urlToString = (url: string | URL | Request): string => {
    if (typeof url === "string") {
        return url;
    }

    return url instanceof URL ? url.href : url.url;
};

/** A `fetch` double that records the call and returns a canned Cloudflare envelope. */
const fakeFetch = (status: number, body: unknown): { calls: { init?: RequestInit; url: string }[]; fetch: typeof globalThis.fetch } => {
    const calls: { init?: RequestInit; url: string }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ init, url: urlToString(url) });

        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        } as Response;
    }) as typeof globalThis.fetch;

    return { calls, fetch };
};

describe("createWorkflowsRestClient", () => {
    it("lists instances, normalizing snake_case + result_info into camelCase", async () => {
        expect.assertions(4);

        const { calls, fetch } = fakeFetch(200, {
            result: [
                { created_on: "2026-06-01T00:00:00Z", id: "a", status: "running" },
                { id: "b", status: "complete" },
            ],
            result_info: { page: 1, per_page: 25, total_count: 2 },
            success: true,
        });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const page = await client.listInstances({ status: "running", workflowName: "order pipeline" });

        expect(page).toStrictEqual({
            instances: [
                { createdOn: "2026-06-01T00:00:00Z", endedOn: undefined, id: "a", startedOn: undefined, status: "running" },
                { createdOn: undefined, endedOn: undefined, id: "b", startedOn: undefined, status: "complete" },
            ],
            page: 1,
            perPage: 25,
            totalCount: 2,
        });
        // workflow name is URL-encoded; the status filter is forwarded as a query param.
        expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/workflows/order%20pipeline/instances?status=running");
        expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
        expect(calls[0]?.init?.method).toBeUndefined();
    });

    it("reads one instance with its step timeline (attempt count from the attempts array)", async () => {
        expect.assertions(2);

        const { fetch } = fakeFetch(200, {
            result: {
                id: "a",
                output: { ok: true },
                status: "complete",
                steps: [
                    { attempts: [{}, {}], end: "t2", name: "charge", start: "t1", success: true, type: "step" },
                    { name: "wait", type: "sleep" },
                ],
            },
            success: true,
        });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const detail = await client.getInstance({ instanceId: "a", workflowName: "wf" });

        expect(detail.steps).toStrictEqual([
            { attempts: 2, end: "t2", error: undefined, name: "charge", output: undefined, start: "t1", success: true, type: "step" },
            { attempts: undefined, end: undefined, error: undefined, name: "wait", output: undefined, start: undefined, success: undefined, type: "sleep" },
        ]);
        expect(detail.output).toStrictEqual({ ok: true });
    });

    it("pATCHes instance status for a lifecycle action", async () => {
        expect.assertions(3);

        const { calls, fetch } = fakeFetch(200, { result: { status: "paused" }, success: true });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const result = await client.setInstanceStatus({ action: "pause", instanceId: "a", workflowName: "wf" });

        expect(result).toStrictEqual({ status: "paused" });
        expect(calls[0]?.init?.method).toBe("PATCH");
        expect(calls[0]?.init?.body).toBe(JSON.stringify({ status: "pause" }));
    });

    it("forwards page + per_page as query params", async () => {
        expect.assertions(2);

        const { calls, fetch } = fakeFetch(200, { result: [], result_info: { page: 2, per_page: 10, total_count: 0 }, success: true });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const page = await client.listInstances({ page: 2, perPage: 10, workflowName: "wf" });

        expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/workflows/wf/instances?page=2&per_page=10");
        expect(page).toStrictEqual({ instances: [], page: 2, perPage: 10, totalCount: 0 });
    });

    it("falls back to the requested page/perPage when result_info omits them", async () => {
        expect.assertions(1);

        const { fetch } = fakeFetch(200, { result: [{ id: "a", status: "running" }], success: true });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const page = await client.listInstances({ page: 3, perPage: 7, workflowName: "wf" });

        expect(page).toMatchObject({ page: 3, perPage: 7, totalCount: undefined });
    });

    it("coerces an unrecognized status to `unknown`", async () => {
        expect.assertions(1);

        const { fetch } = fakeFetch(200, { result: [{ id: "a", status: "frobnicating" }], success: true });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const page = await client.listInstances({ workflowName: "wf" });

        expect(page.instances[0]?.status).toBe("unknown");
    });

    it("throws WorkflowsRestError on a non-2xx response", async () => {
        expect.assertions(2);

        const { fetch } = fakeFetch(403, { errors: [{ message: "Authentication error" }], success: false });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "bad", fetch });

        await expect(client.listInstances({ workflowName: "wf" })).rejects.toThrow(WorkflowsRestError);
        await expect(client.listInstances({ workflowName: "wf" })).rejects.toMatchObject({ status: 403 });
    });

    it("throws WorkflowsRestError when `success: false` despite a 200", async () => {
        expect.assertions(1);

        const { fetch } = fakeFetch(200, { errors: [{ message: "nope" }], success: false });
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        await expect(client.getInstance({ instanceId: "a", workflowName: "wf" })).rejects.toThrow(WorkflowsRestError);
    });

    it("treats a non-JSON error body (gateway 5xx) as a REST error, not a parse crash", async () => {
        expect.assertions(1);

        const { fetch } = fakeFetch(502, "<html>Bad Gateway</html>");
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        await expect(client.listInstances({ workflowName: "wf" })).rejects.toThrow(WorkflowsRestError);
    });

    it("caps the upstream body in the message and keeps the whole of it on cause", async () => {
        expect.assertions(4);

        // `WORKFLOWS_REST_ERROR` is a catalogued (non-internal) code, so
        // `toErrorBody` echoes this message VERBATIM to whoever called the
        // action — an uncapped body puts a multi-KB gateway page, or the
        // Cloudflare API's auth error text, on the wire to a browser.
        const body = `<html>${"A".repeat(10_000)}</html>`;
        const { fetch } = fakeFetch(502, body);
        const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok", fetch });

        const error = (await client.listInstances({ workflowName: "wf" }).catch((error_: unknown) => error_)) as WorkflowsRestError;

        expect(error).toBeInstanceOf(WorkflowsRestError);
        expect(error.status).toBe(502);
        expect(error.message.length).toBeLessThan(400);
        // The full text is still available server-side, on `cause` — which
        // `toErrorBody` never serialises.
        expect(error.cause).toBe(body);
    });

    it("calls the global fetch bound to globalThis (no `this`-strict 'Illegal invocation')", async () => {
        // A receiver-strict `fetch` throws TypeError unless invoked with the global
        // as its receiver. We model that here and rely on the default (no injected
        // `config.fetch`) path binding `globalThis.fetch` to `globalThis`.
        expect.assertions(2);

        const original = globalThis.fetch;
        let boundToGlobal = false;

        const strictFetch = function strictFetch(this: unknown): Promise<Response> {
            // The strict guard rejects any receiver that is not the global; a
            // success proves the client invoked `fetch` bound to `globalThis`.
            if (this !== globalThis) {
                throw new TypeError("Illegal invocation");
            }

            boundToGlobal = true;

            return Promise.resolve({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ result: { id: "a", status: "complete", steps: [] }, success: true }),
            } as Response);
        } as unknown as typeof globalThis.fetch;

        globalThis.fetch = strictFetch;

        try {
            const client = createWorkflowsRestClient({ accountId: "acc", apiToken: "tok" });

            await expect(client.getInstance({ instanceId: "a", workflowName: "wf" })).resolves.toMatchObject({ id: "a" });
            expect(boundToGlobal).toBe(true);
        } finally {
            globalThis.fetch = original;
        }
    });
});
