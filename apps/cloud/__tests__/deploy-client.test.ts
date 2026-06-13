import { describe, expect, it, vi } from "vitest";

import { deployToCloud } from "../src/deploy/client";

const ndjsonResponse = (lines: object[]): Response => new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { status: 200 });

describe(deployToCloud, () => {
    it("posts with the bearer key + body and streams each NDJSON event", async () => {
        const events: object[] = [];
        const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
            ndjsonResponse([
                { deploymentId: "d1", event: "accepted" },
                { deploymentId: "d1", phase: "queued" },
                { deploymentId: "d1", phase: "live" },
                { deploymentId: "d1", done: true, status: "live" },
            ]),
        );

        const result = await deployToCloud(
            {
                apiUrl: "https://cloud.example.com/",
                deployKey: "production:org|secret",
                fetch: fetchMock as unknown as typeof fetch,
                kind: "production",
                projectId: "p1",
                scriptName: "s1",
            },
            (event) => events.push(event),
        );

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe("https://cloud.example.com/v1/deploy");
        expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer production:org|secret");
        // `branch` is undefined here, so JSON.stringify omits the key entirely.
        expect(JSON.parse(init.body as string)).toStrictEqual({ kind: "production", projectId: "p1", scriptName: "s1" });
        expect(events).toHaveLength(4);
        expect(result.status).toBe("live");
    });

    it("throws on a non-OK response", async () => {
        const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => new Response("nope", { status: 403 }));

        await expect(
            deployToCloud({ apiUrl: "https://c", deployKey: "k", fetch: fetchMock as unknown as typeof fetch, projectId: "p", scriptName: "s" }, () => {}),
        ).rejects.toThrow(/deploy request failed \(403\)/u);
    });
});
