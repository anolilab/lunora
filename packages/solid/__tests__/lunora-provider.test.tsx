import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useLunora } from "../src/context";
import { createFakeClient } from "./fake-client";

describe(LunoraProvider, () => {
    it("wires the client so useLunora resolves it from context", () => {
        const fake = createFakeClient();
        let resolved: unknown;

        render(
            () => {
                resolved = useLunora();

                return <div>ok</div>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(resolved).toBe(fake.asClient);
    });

    it("throws a helpful error when a primitive is used outside a provider", () => {
        expect(() => {
            render(() => {
                useLunora();

                return <div>nope</div>;
            });
        }).toThrow("useLunora must be used inside <LunoraProvider />");
    });
});
