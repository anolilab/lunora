import { describe, expect, it } from "vitest";

import { jsonResponse } from "../../../shared/json-response";

describe("jsonResponse", () => {
    it("defaults to a JSON content type and the given status", async () => {
        expect.assertions(3);

        const response = jsonResponse({ ok: true }, 201);

        expect(response.status).toBe(201);
        expect(response.headers.get("content-type")).toBe("application/json");
        await expect(response.json()).resolves.toStrictEqual({ ok: true });
    });

    it("lets a caller override the content type whatever case they spell it in", () => {
        expect.assertions(2);

        // HTTP header names are case-insensitive, so an object spread kept
        // `content-type` and `Content-Type` as two distinct keys and `Headers`
        // then COMBINED them into `application/json, application/problem+json` —
        // a media type no client can parse — instead of honouring the override
        // the docblock promises.
        expect(jsonResponse({}, 400, { "Content-Type": "application/problem+json" }).headers.get("content-type")).toBe("application/problem+json");
        expect(jsonResponse({}, 400, { "content-type": "application/problem+json" }).headers.get("content-type")).toBe("application/problem+json");
    });

    it("carries consumer-specific headers through", () => {
        expect.assertions(1);

        expect(jsonResponse({}, 200, { "x-d1-bookmark": "0000-abc" }).headers.get("x-d1-bookmark")).toBe("0000-abc");
    });
});
