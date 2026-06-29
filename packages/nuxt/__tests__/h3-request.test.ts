import { describe, expect, it, vi } from "vitest";

import { resolveWebRequest } from "../src/runtime/h3-request";

// `resolveWebRequest` is the one piece of the `/_lunora/**` Nitro handler that
// changes shape across the widened `h3: "^1.0.0 || ^2.0.0"` peer range, so it is
// the thing the new v2 support actually has to get right. v1 exposes
// `toWebRequest(event)`; v2 removed it and carries the web `Request` as
// `event.req`. Driving both stubs here exercises the v2 path deterministically
// without installing a second h3 major or booting Nitro — a CI matrix over the
// installed h3 version could not reach the branch that no real fixture hits.
describe("resolveWebRequest across the h3 v1 → v2 seam", () => {
    it("calls toWebRequest(event) under h3 v1", () => {
        const request = new Request("https://app.test/_lunora/rpc", { method: "POST" });
        const toWebRequest = vi.fn(() => request);
        const event = { context: {} };

        expect(resolveWebRequest({ toWebRequest }, event)).toBe(request);
        expect(toWebRequest).toHaveBeenCalledWith(event);
    });

    it("reads event.req when h3 v2 dropped toWebRequest", () => {
        const request = new Request("https://app.test/_lunora/ws");

        // v2: `toWebRequest` is absent, so the namespace reads back `undefined`
        // (a real ESM namespace returns undefined for a missing export, not a throw).
        expect(resolveWebRequest({}, { req: request })).toBe(request);
    });
});
