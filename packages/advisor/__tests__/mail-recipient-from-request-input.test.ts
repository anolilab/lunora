import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import mailRecipientFromRequestInput from "../src/lints/static/mail-recipient-from-request-input";
import type { AdvisorMailRecipientAccess } from "../src/mail-recipient-accesses";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("mail_recipient_from_request_input", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const mailRecipientAccesses: AdvisorMailRecipientAccess[] = [
            { exportName: "notify", file: "notifications", line: 4, method: "send" },
            { exportName: "relay", file: "notifications", line: 9, method: "queue" },
        ];
        const findings = mailRecipientFromRequestInput.run({ mailRecipientAccesses, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "mail_recipient_from_request_input:notifications:4",
            level: "WARN",
            metadata: { exportName: "notify", method: "send" },
            name: "mail_recipient_from_request_input",
        });
        expect(findings[0]?.detail).toContain("ctx.mail.send");
        expect(findings[1]?.cacheKey).toBe("mail_recipient_from_request_input:notifications:9");
    });

    it("finds nothing when the feeder supplies no mail recipient evidence", () => {
        expect.assertions(2);

        expect(mailRecipientFromRequestInput.run({ schema: schema() })).toHaveLength(0);
        expect(mailRecipientFromRequestInput.run({ mailRecipientAccesses: [], schema: schema() })).toHaveLength(0);
    });
});
