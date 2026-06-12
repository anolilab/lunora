import { describe, expect, it, vi } from "vitest";

import type { CapturedMail } from "../src/capture-transport";
import { extractLink, listCapturedMail, waitForMail } from "../src/testing";

const mail = (over: Partial<CapturedMail>): CapturedMail => {
    return { capturedAt: 1, id: "m1", subject: "Subject", to: "user@x.test", ...over };
};

const stubFetch = (entries: CapturedMail[]) =>
    vi.fn<
        (
            input: string,
            init?: { body?: string; headers?: Record<string, string>; method?: string },
        ) => Promise<{ json: () => Promise<unknown>; ok: boolean; status: number }>
    >(async () => {
        return {
            json: async () => {
                return { result: { entries } };
            },
            ok: true,
            status: 200,
        };
    });

describe("@cirrus/mail/testing", () => {
    it("listCapturedMail posts the admin op with the bearer and returns entries", async () => {
        expect.assertions(3);

        const entries = [mail({ id: "a" })];
        const fetch = stubFetch(entries);

        const result = await listCapturedMail({ adminToken: "secret", baseUrl: "https://localhost:8787/", fetch });

        expect(result).toStrictEqual(entries);

        const [url, init] = fetch.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];

        expect(url).toBe("https://localhost:8787/_cirrus/rpc");
        expect(init.headers.authorization).toBe("Bearer secret");
    });

    it("waitForMail returns the newest message matching the recipient + subject", async () => {
        expect.assertions(1);

        const entries = [mail({ id: "new", subject: "Reset your password", to: "user@x.test" }), mail({ id: "other", to: "someone@x.test" })];
        const found = await waitForMail({ adminToken: "t", baseUrl: "https://h", fetch: stubFetch(entries), subjectMatch: "Reset", to: "user@x.test" });

        expect(found.id).toBe("new");
    });

    it("waitForMail times out when no message matches", async () => {
        expect.assertions(1);

        await expect(
            waitForMail({ adminToken: "t", baseUrl: "https://h", fetch: stubFetch([]), pollMs: 1, timeoutMs: 5, to: "nobody@x.test" }),
        ).rejects.toThrow(/no mail/);
    });

    it("extractLink pulls the matching link from html, then text", async () => {
        expect.assertions(2);

        const withHtml = mail({ html: '<a href="https://x.test/reset-password?token=abc">reset</a> <a href="https://x.test/logo.png">l</a>' });

        expect(extractLink(withHtml, { match: "/reset-password" })).toBe("https://x.test/reset-password?token=abc");

        const textOnly = mail({ text: "Open https://x.test/verify?token=zzz to continue" });

        expect(extractLink(textOnly, { match: "/verify" })).toBe("https://x.test/verify?token=zzz");
    });

    it("extractLink throws when no matching link exists", () => {
        expect.assertions(1);

        expect(() => extractLink(mail({ text: "no links here" }))).toThrow(/no link/);
    });
});
