import { describe, expect, it } from "vitest";

import { ADVISOR_PROCEDURES_PATH, createCompanionHandler } from "../../src/studio-host/companion-worker";

const TOKEN = "companion-test-token-0123456789";
const PROCEDURES = `${JSON.stringify({ procedures: [{ exportName: "list", file: "todos", kind: "query" }] }, undefined, 2)}\n`;

const handler = createCompanionHandler({ adminToken: TOKEN, procedures: PROCEDURES });

const get = (path: string, headers: Record<string, string> = {}): Request => new Request(`https://worker.example${path}`, { headers, method: "GET" });

describe("createCompanionHandler", () => {
    it("serves the embedded procedure list to a caller with the admin token", async () => {
        expect.assertions(3);

        const response = handler(get(ADVISOR_PROCEDURES_PATH, { Authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("application/json");
        await expect(response.text()).resolves.toBe(PROCEDURES);
    });

    it("answers 401 without a token, before reading the path", () => {
        expect.assertions(1);

        expect(handler(get(ADVISOR_PROCEDURES_PATH)).status).toBe(401);
    });

    it("answers 401 for a wrong token, including a prefix of the real one", () => {
        expect.assertions(2);

        expect(handler(get(ADVISOR_PROCEDURES_PATH, { Authorization: "Bearer wrong" })).status).toBe(401);
        expect(handler(get(ADVISOR_PROCEDURES_PATH, { Authorization: `Bearer ${TOKEN.slice(0, 10)}` })).status).toBe(401);
    });

    it("answers 404 for any other path once authorized", () => {
        expect.assertions(1);

        expect(handler(get("/admin", { Authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    });

    it("refuses non-GET methods once authorized", () => {
        expect.assertions(1);

        const request = new Request(`https://worker.example${ADVISOR_PROCEDURES_PATH}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
            method: "POST",
        });

        expect(handler(request).status).toBe(405);
    });
});
