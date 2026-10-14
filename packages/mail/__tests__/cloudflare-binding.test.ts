import { describe, expect, it, vi } from "vitest";

import createMailer from "../src/create-mailer";

/**
 * Drives the REAL `@visulima/email` Cloudflare provider — no module mock.
 *
 * The provider rejects a send whose `cc`/`bcc` is merely *present*
 * (`cc !== undefined`), not just non-empty, and that rejection is flattened into
 * the generic "send failed" with the binding never called. A mocked provider
 * cannot see that, so the empty-list path has to be covered against the real one.
 */
describe("cloudflare transport against the real provider", () => {
    it("invokes the send binding when `cc`/`bcc` are empty arrays", async () => {
        expect.assertions(3);

        const cloudflareSend = vi.fn<(from: string, to: string, raw: string) => Promise<void>>(async () => undefined);
        const mailer = createMailer({ cloudflareSend, from: "noreply@x.test" });

        const result = await mailer.send({ bcc: [], cc: [], subject: "Hi", text: "x", to: "user@x.test" });

        expect(cloudflareSend).toHaveBeenCalledTimes(1);
        expect(cloudflareSend.mock.calls[0]?.slice(0, 2)).toStrictEqual(["noreply@x.test", "user@x.test"]);
        expect(result.id).toStrictEqual(expect.any(String));
    });

    it("invokes the send binding when no `cc`/`bcc` is supplied at all", async () => {
        expect.assertions(1);

        const cloudflareSend = vi.fn<(from: string, to: string, raw: string) => Promise<void>>(async () => undefined);
        const mailer = createMailer({ cloudflareSend, from: "noreply@x.test" });

        await mailer.send({ subject: "Hi", text: "x", to: "user@x.test" });

        expect(cloudflareSend).toHaveBeenCalledTimes(1);
    });
});
