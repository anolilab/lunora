// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { AdapterDriver } from "../../client/__tests__/lib/adapter-scenarios";
import { scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import createReactDriver from "../../react/__tests__/parity-driver";
import { LunoraProvider, useMutation, usePresence, useQuery, useSubscription } from "../src";

// The hooks are `@lunora/react`'s, star re-exported — so drive them through this package's barrel with the React
// driver. jsdom only hosts React's renderer; none of the four hooks needs a browser-only global.
const driver: AdapterDriver = createReactDriver({ LunoraProvider, useMutation, usePresence, useQuery, useSubscription });

describe("@lunora/react-native behavioural parity", () => {
    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
