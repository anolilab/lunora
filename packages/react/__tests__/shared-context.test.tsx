import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { createMockClient } from "./mock-client";

// Two module instances of this package, as a bundle holding two pnpm peer variants has them. Each `import` after
// `vi.resetModules()` evaluates the source again, so each copy calls its own `createContext` unless the contexts are shared.
const loadCopy = async (): Promise<typeof import("../src/lunora-provider")> => {
    vi.resetModules();

    return import("../src/lunora-provider");
};

describe("lunoraProvider across copies of the package", () => {
    it("a hook from one copy reads the provider of another copy", async () => {
        expect.assertions(2);

        const providerCopy = await loadCopy();
        const hookCopy = await loadCopy();

        // Only a real second copy makes this test mean anything.
        expect(hookCopy.useLunora).not.toBe(providerCopy.useLunora);

        const mock = createMockClient();

        const Probe = (): ReactElement => {
            const client = hookCopy.useLunora();

            return <div data-testid="probe">{client === mock.asClient ? "same" : "other"}</div>;
        };

        render(
            <providerCopy.LunoraProvider client={mock.asClient}>
                <Probe />
            </providerCopy.LunoraProvider>,
        );

        expect(screen.getByTestId("probe").textContent).toBe("same");
    });
});
