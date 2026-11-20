import { describe, expect, it } from "vitest";

import { cloudflareWfpCanConverge, cloudflareWfpDriverFromEnv } from "../src/targets/cloudflare-wfp/driver";

const spec = { alias: "notes-abc123" } as Parameters<ReturnType<typeof cloudflareWfpDriverFromEnv>["deploy"]>[0];

describe("the cloudflare-wfp dispatch namespace", () => {
    it.each([
        ["unset", {}],
        ["blank", { LUNORA_DISPATCH_NAMESPACE: "  " }],
    ])("does not converge while LUNORA_DISPATCH_NAMESPACE is %s", (_label, namespace) => {
        expect(cloudflareWfpCanConverge({ CONTAINER_PROVISION_BOX: {}, ...namespace })).toBe(false);
    });

    it("converges once the namespace and the provision box are both set", () => {
        expect(cloudflareWfpCanConverge({ CONTAINER_PROVISION_BOX: {}, LUNORA_DISPATCH_NAMESPACE: "lunora-staging" })).toBe(true);
    });

    it("refuses a deploy or teardown without a namespace instead of guessing production's", async () => {
        const driver = cloudflareWfpDriverFromEnv({ CONTAINER_PROVISION_BOX: {} });

        await expect(driver.deploy(spec, {})).rejects.toMatchObject({ code: "MISCONFIGURED" });
        await expect(driver.destroy("notes-abc123")).rejects.toMatchObject({ code: "MISCONFIGURED" });
    });
});
