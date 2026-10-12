import { describe, expect, it } from "vitest";

import { withPlatformHeaders } from "../src/dispatcher/platform-headers";

describe(withPlatformHeaders, () => {
    it("sets X-Content-Type-Options: nosniff on a response", () => {
        expect.assertions(2);

        const stamped = withPlatformHeaders(new Response("ok", { status: 200 }));

        expect(stamped.headers.get("x-content-type-options")).toBe("nosniff");
        expect(stamped.status).toBe(200);
    });

    it("sets the default Referrer-Policy when the tenant set none", () => {
        expect.assertions(1);

        const stamped = withPlatformHeaders(new Response("ok", { status: 200 }));

        expect(stamped.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    });

    it("keeps a Referrer-Policy the tenant set", () => {
        expect.assertions(1);

        const stamped = withPlatformHeaders(new Response("ok", { headers: { "referrer-policy": "no-referrer" }, status: 200 }));

        expect(stamped.headers.get("referrer-policy")).toBe("no-referrer");
    });

    it("stamps x-lunora-id in the same copy when the dispatcher served a tenant", () => {
        expect.assertions(2);

        const stamped = withPlatformHeaders(new Response("ok", { status: 200 }), "default:tenant-a");

        expect(stamped.headers.get("x-lunora-id")).toBe("default:tenant-a");
        expect(stamped.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("returns a 101 upgrade verbatim, with no stamp", () => {
        expect.assertions(2);

        // A 101 cannot be built with the constructor, so the status is set on the instance.
        const upgrade = Object.defineProperty(new Response(null), "status", { value: 101 });
        const stamped = withPlatformHeaders(upgrade, "default:tenant-a");

        expect(stamped).toBe(upgrade);
        expect(stamped.headers.get("x-lunora-id")).toBeNull();
    });
});
