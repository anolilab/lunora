import { describe, expect, it } from "vitest";

import { ADVISOR_PROCEDURES_PATH, createCompanionHandler } from "../../src/studio-host/companion-worker";

const PROCEDURES = `${JSON.stringify({ procedures: [{ exportName: "list", file: "todos", kind: "query" }] }, undefined, 2)}\n`;

const handler = createCompanionHandler({ procedures: PROCEDURES });

const get = (path: string, headers: Record<string, string> = {}): Request => new Request(`https://worker.example${path}`, { headers, method: "GET" });

describe("createCompanionHandler", () => {
    it("serves the embedded procedure list", async () => {
        expect.assertions(3);

        const response = handler(get(ADVISOR_PROCEDURES_PATH));

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("application/json");
        await expect(response.text()).resolves.toBe(PROCEDURES);
    });

    it("answers 404 for any other path", () => {
        expect.assertions(1);

        expect(handler(get("/admin")).status).toBe(404);
    });

    it("refuses non-GET methods", () => {
        expect.assertions(1);

        const request = new Request(`https://worker.example${ADVISOR_PROCEDURES_PATH}`, { method: "POST" });

        expect(handler(request).status).toBe(405);
    });
});
