import { describe, expect, it } from "vitest";

import { buildAuditEntry } from "../src/audit-hooks";

describe("a form-encoded client id is read as the client named", () => {
    it("reads a plus sign in a Basic client id as a space, as form encoding does", () => {
        expect.assertions(1);

        const credential = Buffer.from("My+App:secret").toString("base64");
        const entry = buildAuditEntry({
            body: { grant_type: "authorization_code", code: "c" },
            headers: new Headers({ authorization: `Basic ${credential}` }),
            path: "/api/auth/oauth2/token",
        });

        expect(entry?.detail).toMatchObject({ clientId: "My App" });
    });
});

describe("an invitation answer names the organization it returns", () => {
    it("names the organization an accepted invitation belongs to, from the invitation it returns", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({
            body: { invitationId: "inv_9" },
            context: { returned: { invitation: { id: "inv_9", organizationId: "org_c" }, member: { id: "m_1" } } },
            path: "/api/auth/organization/accept-invitation",
        });

        expect(entry?.detail).toMatchObject({ organizationId: "org_c", invitationId: "inv_9" });
    });
});
