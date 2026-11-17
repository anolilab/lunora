import { describe, expect, it } from "vitest";

import { MAX_WAITLIST_BODY_BYTES, readWaitlistBody } from "../src/lib/waitlist-body";

const post = (body: string, headers: Record<string, string> = {}): Request =>
    new Request("https://lunora.sh/api/waitlist", { body, headers: { "content-type": "application/json", ...headers }, method: "POST" });

describe(readWaitlistBody, () => {
    it("reads a sign-up object", async () => {
        expect.assertions(1);

        await expect(readWaitlistBody(post(JSON.stringify({ email: "a@b.co", privacy: true })))).resolves.toStrictEqual({ email: "a@b.co", privacy: true });
    });

    it.each(["null", "[]", "42", '"a@b.co"', "{"])("refuses %s, which is not a JSON object", async (body) => {
        expect.assertions(1);

        await expect(readWaitlistBody(post(body))).resolves.toBeUndefined();
    });

    it("refuses a body over the limit before parsing it, whatever its content-length says", async () => {
        expect.assertions(2);

        const large = JSON.stringify({ email: "a@b.co", padding: "x".repeat(MAX_WAITLIST_BODY_BYTES) });

        await expect(readWaitlistBody(post(large))).resolves.toBe("too_large");
        await expect(readWaitlistBody(post("{}", { "content-length": String(MAX_WAITLIST_BODY_BYTES + 1) }))).resolves.toBe("too_large");
    });
});
