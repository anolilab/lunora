import { describe, expect, it } from "vitest";

import { planRunWorkerFirst, workerPathRules } from "../../src/cloudflare/reconcile-assets";

describe(workerPathRules, () => {
    it.each([
        ["/webhooks/stripe", ["/webhooks/stripe"]],
        ["/posts/:slug", ["/posts/*"]],
        ["/api/todos/:id/comments", ["/api/todos/*"]],
        ["/files/*", ["/files", "/files/*"]],
        ["/users/:id{[0-9]+}", ["/users/*"]],
        ["/a/:b?", ["/a/*"]],
    ])("widens %s to its static prefix", (route, rules) => {
        expect.assertions(1);

        expect(workerPathRules(route)).toStrictEqual(rules);
    });

    it.each([["/:tenant/api"], ["/*"], ["/"]])("cannot narrow %s, whose first segment is not static", (route) => {
        expect.assertions(1);

        expect(workerPathRules(route)).toBeUndefined();
    });
});

describe(planRunWorkerFirst, () => {
    it("keeps the reserved paths first, drops rules a wider one covers, and sorts the rest", () => {
        expect.assertions(1);

        expect(planRunWorkerFirst(["/api/x/:id", "/api/*", "/z", "/api/y", "/_lunora/custom"]).rules).toStrictEqual([
            "/_lunora/*",
            "/__lunora/*",
            "/api",
            "/api/*",
            "/z",
        ]);
    });

    it("warns for a route it cannot narrow, and stays within Cloudflare's 100 rules", () => {
        expect.assertions(3);

        const routes = Array.from({ length: 120 }, (_, index) => `/r${String(index).padStart(3, "0")}`);
        const plan = planRunWorkerFirst([...routes, "/:tenant/x"]);

        expect(plan.rules).toHaveLength(100);
        expect(plan.warnings.join(" ")).toContain("Cloudflare accepts 100");
        expect(plan.warnings.join(" ")).toContain('"/:tenant/x" starts with a parameter');
    });
});
