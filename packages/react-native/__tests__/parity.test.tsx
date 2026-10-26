// @vitest-environment jsdom
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest globals are disabled, so RTL's auto-cleanup is inactive and this manual cleanup is required for test isolation.
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterDriver } from "../../client/__tests__/lib/adapter-scenarios";
import { scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import createReactDriver from "../../react/__tests__/parity-driver";
import { LunoraProvider, useMutation, usePresence, useQuery, useSubscription } from "../src";

// The hooks are `@lunora/react`'s, star re-exported — so drive them through this package's barrel with the React
// driver. jsdom only hosts React's renderer; none of the four hooks needs a browser-only global.
const driver: AdapterDriver = createReactDriver({ LunoraProvider, useMutation, usePresence, useQuery, useSubscription });

describe("@lunora/react-native behavioural parity", () => {
    // Vitest globals are off, so Testing Library never registers its own cleanup. Unmount every tree after each
    // scenario, including one whose assertion failed before its `dispose` ran.
    afterEach(() => {
        cleanup();
    });

    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
