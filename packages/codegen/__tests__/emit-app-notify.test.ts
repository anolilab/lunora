import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

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
