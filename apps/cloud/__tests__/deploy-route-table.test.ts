import { describe, expect, it, vi } from "vitest";

import type { RegisteredRoute } from "../src/deploy/route-registry";
import { createDeployRouter } from "../src/deploy/router";

/**
 * The route table is built inside `createDeployRouter` and never exported, so the
 * registry's own boot check is the seam: it receives every route, in table order,
 * before anything dispatches. Capturing it pins the table without a second copy of
 * the list. The admin guards are identity functions here so each entry keeps the
 * handler it was declared with, and its name is what the snapshot records.
 */
const captured = vi.hoisted(() => {
    return { routes: undefined as undefined | RegisteredRoute<unknown>[] };
});

vi.mock(import("../src/deploy/route-registry"), async (importOriginal) => {
    const original = await importOriginal<typeof import("../src/deploy/route-registry")>();

    return {
        ...original,
        assertRoutesClassified: <Handler>(routes: ReadonlyArray<RegisteredRoute<Handler>>) => {
            captured.routes = [...routes] as RegisteredRoute<unknown>[];

            return original.assertRoutesClassified(routes);
        },
    };
});

vi.mock(import("../src/deploy/routes/tenant-admin"), async (importOriginal) => {
    const original = await importOriginal<typeof import("../src/deploy/routes/tenant-admin")>();

    return {
        ...original,
        refuseAdminToken: <T>(handler: T): T => handler,
        withAdminToken: <T>(handler: T): T => handler,
    };
});

describe("deploy route table", () => {
    it("keeps every route's method, path, auth tier, rate tier and handler", () => {
        createDeployRouter();

        const table = (captured.routes ?? []).map((route) => {
            return {
                handler: (route.handler as { name: string }).name,
                method: route.method,
                path: route.path,
                spec: route.spec,
            };
        });

        expect(table).toMatchSnapshot();
    });
});
