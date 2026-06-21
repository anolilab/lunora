import type { LunoraClient } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { createApp, effectScope } from "vue";

import { createLunora, LUNORA_INJECTION_KEY, useLunora } from "../src/lunora-provider";

const fakeClient = { __fake: true } as unknown as LunoraClient;

describe("lunora-provider", () => {
    it("createLunora installs the client so useLunora resolves it", () => {
        const app = createApp({});

        app.use(createLunora(fakeClient));

        const resolved = app.runWithContext(() => useLunora());

        expect(resolved).toBe(fakeClient);
    });

    it("useLunora throws a pointed error when no client is provided", () => {
        const app = createApp({});
        const scope = effectScope();

        expect(() => app.runWithContext(() => scope.run(() => useLunora()))).toThrow("no LunoraClient provided");

        scope.stop();
    });

    it("exposes a stable injection key consumers can inject by hand", () => {
        const app = createApp({});

        app.provide(LUNORA_INJECTION_KEY, fakeClient);

        const resolved = app.runWithContext(() => useLunora());

        expect(resolved).toBe(fakeClient);
    });
});
