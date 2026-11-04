import { AUTH_ROUTE_BASE_PATH } from "@lunora/config";
import { describe, expect, it } from "vitest";

import { DEFAULT_AUTH_BASE_PATH } from "../src/handler";

describe("the auth base path @lunora/config routes to the Worker", () => {
    // `@lunora/config` cannot import this package (the dependency runs the other way), so it keeps its own copy for
    // `assets.run_worker_first`. A rename here that is not made there leaves auth routes to the static assets.
    it("is the base path the auth handler mounts at", () => {
        expect.assertions(1);

        expect(AUTH_ROUTE_BASE_PATH).toBe(DEFAULT_AUTH_BASE_PATH);
    });
});
