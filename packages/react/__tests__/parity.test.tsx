import { describe, expect, it } from "vitest";

import type { AdapterDriver } from "../../client/__tests__/lib/adapter-scenarios";
import { scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import { LunoraProvider, useMutation, usePresence, useQuery, useSubscription } from "../src";
import createReactDriver from "./parity-driver";

const driver: AdapterDriver = createReactDriver({ LunoraProvider, useMutation, usePresence, useQuery, useSubscription });

describe("@lunora/react behavioural parity", () => {
    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
