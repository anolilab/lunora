import { describe, expect, it } from "vitest";

import { planRunWorkerFirst, runWorkerFirstProblems, workerPathRules } from "../../src/cloudflare/reconcile-assets";

/** Whether Cloudflare's router sends `pathname` to the Worker for `rules`: its rules engine reads each `*` as `.*`. */
const routesToWorker = (rules: ReadonlyArray<string>, pathname: string): boolean =>
    rules.some((rule) =>
        new RegExp(
            `^${rule
                .split("*")
                .map((part) => part.replaceAll(/[$()*+./?[\\\]^{|}-]/gu, String.raw`\$&`))
                .join(".*")}$`,
            "u",
        ).test(pathname),
    );

describe(workerPathRules, () => {
    it.each([
        ["/webhooks/stripe", ["/webhooks/stripe"]],
        ["/posts/:slug", ["/posts/*"]],
        ["/api/todos/:id/comments", ["/api/todos/*/comments"]],
        ["/files/*", ["/files", "/files/*"]],
        ["/users/:id{[0-9]+}", ["/users/*"]],
        ["/a/:b?", ["/a", "/a/*"]],
        // The bare prefix of an optional tail keeps the earlier parameter a wildcard too.
        ["/orgs/:orgId/:child?", ["/orgs/*", "/orgs/*/*"]],
        ["/orgs/:orgId/files/*", ["/orgs/*/files", "/orgs/*/files/*"]],
    ])("turns %s into rules that name it", (route, rules) => {
        expect.assertions(1);

        expect(workerPathRules(route)).toStrictEqual(rules);
    });

    it.each([["/:tenant/api"], ["/*"], ["/"]])("cannot name %s without sending every path to the Worker", (route) => {
        expect.assertions(1);

        expect(workerPathRules(route)).toBeUndefined();
    });

    it("sends a route with a parameter inside it to the Worker, and leaves its siblings to the SPA", () => {
        expect.assertions(4);

        const { rules } = planRunWorkerFirst(["/users/:id/avatar.png"]);

        expect(routesToWorker(rules, "/users/42/avatar.png")).toBe(true);
        expect(routesToWorker(rules, "/_lunora/rpc")).toBe(true);
        // A deep link into the SPA, and a real file under public/users/, are not the Worker's.
        expect(routesToWorker(rules, "/users/42")).toBe(false);
        expect(routesToWorker(rules, "/users/logo.svg")).toBe(false);
    });
});

describe(planRunWorkerFirst, () => {
    it("keeps the reserved paths first, drops rules a wider one covers, and sorts the rest", () => {
        expect.assertions(1);

        expect(planRunWorkerFirst(["/api/x/:id", "/api/*", "/z", "/api/y", "/_lunora/custom", "/b/:id", "/b/:id/c"]).rules).toStrictEqual([
            "/_lunora/*",
            "/__lunora/*",
            "/api",
            "/api/*",
            "/b/*",
            "/z",
        ]);
    });

    it("plans a list wrangler accepts", () => {
        expect.assertions(1);

        expect(runWorkerFirstProblems(planRunWorkerFirst(["/a/:x", "/a/:x/b", "/files/*", "/files", "/z"]).rules)).toStrictEqual([]);
    });

    it("warns for a route it cannot name, and stays within Cloudflare's 100 rules", () => {
        expect.assertions(4);

        const routes = Array.from({ length: 120 }, (_, index) => `/r${String(index).padStart(3, "0")}`);
        const plan = planRunWorkerFirst([...routes, "/:tenant/x", "/"]);

        expect(plan.rules).toHaveLength(100);
        expect(plan.warnings.join(" ")).toContain("Cloudflare accepts 100");
        expect(plan.warnings.join(" ")).toContain('"/:tenant/x" starts with a parameter');
        expect(plan.warnings.join(" ")).toContain('the route "/" is the site root');
    });
});

describe(runWorkerFirstProblems, () => {
    it.each([
        [[], "empty list"],
        [["!/static/*"], "only negative"],
        [["/api/*", "/api/*"], 'lists "/api/*" twice'],
        [["/api/*", "/api/users"], '"/api/users" is already covered by "/api/*"'],
        [["/a", "!/b/*", "!/b/c"], '"!/b/c" is already covered by "!/b/*"'],
        [["api/*"], 'must be a path rule starting with "/"'],
    ])("refuses %j as wrangler does", (rules, problem) => {
        expect.assertions(1);

        expect(runWorkerFirstProblems(rules).join(" ")).toContain(problem);
    });

    it("counts duplicates toward the 100-rule cap", () => {
        expect.assertions(1);

        expect(runWorkerFirstProblems(Array.from<string>({ length: 101 }).fill("/a")).join(" ")).toContain("at most 100, duplicates included");
    });
});
