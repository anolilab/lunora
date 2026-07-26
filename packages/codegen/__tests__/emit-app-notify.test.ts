import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — notify subscription store wiring", () => {
    it("widens `env` when handing it to the `defineNotify` store factory", () => {
        expect.assertions(2);

        // `defineApp`'s `Env` is bound to `object` so a wrangler-generated
        // `interface Env` is accepted; `defineNotify`'s `store` takes `NotifyEnv`
        // (`Record<string, unknown>`), which an interface does not satisfy. Passing
        // `env` through unwidened made every notify app's generated `app.ts` fail
        // tsc with TS2345 ("Index signature for type 'string' is missing").
        const output = emitApp({ ...baseOptions, hasNotify: true });

        expect(output).toContain("options.notifySubscriptionStore = notifyConfig.store ? notifyConfig.store(env as Record<string, unknown>) : undefined;");
        expect(output).toContain('import notifyConfig from "../notify.js";');
    });

    it("emits nothing notify-related when the app declares no lunora/notify.ts", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).not.toContain("notifySubscriptionStore");
        expect(output).not.toContain("notifyConfig");
    });
});
