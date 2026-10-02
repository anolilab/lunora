import { describe, expect, it } from "vitest";

import { domain } from "../lunora/boxes";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/** `boxes.domain`: the apex the studio prints box hostnames under (plan 458 W9). */
describe("boxes.domain", () => {
    it("answers the configured LUNORA_BOX_DOMAIN to a member", async () => {
        const ctx = { ...makeCtx({ members: [owner("org_1")] }).ctx, env: { LUNORA_BOX_DOMAIN: "boxes.staging.lunora.app" } };

        await expect(domain.handler(ctx as never, { organizationId: "org_1" as never })).resolves.toBe("boxes.staging.lunora.app");
    });

    it("falls back to the production apex when the var is unset", async () => {
        const { ctx } = makeCtx({ members: [owner("org_1")] });

        await expect(domain.handler(ctx as never, { organizationId: "org_1" as never })).resolves.toBe("boxes.lunora.app");
    });

    it("answers nobody outside the organization", async () => {
        const { ctx } = makeCtx({ members: [owner("org_2")] });

        await expect(domain.handler(ctx as never, { organizationId: "org_1" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
