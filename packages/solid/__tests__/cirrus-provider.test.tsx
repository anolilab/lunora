import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider";
import { useCirrus } from "../src/context";
import { createFakeClient } from "./fake-client";

describe(CirrusProvider, () => {
    it("wires the client so useCirrus resolves it from context", () => {
        const fake = createFakeClient();
        let resolved: unknown;

        render(
            () => {
                resolved = useCirrus();

                return <div>ok</div>;
            },
            { wrapper: (props) => <CirrusProvider client={fake.asClient}>{props.children}</CirrusProvider> },
        );

        expect(resolved).toBe(fake.asClient);
    });

    it("throws a helpful error when a primitive is used outside a provider", () => {
        expect(() => {
            render(() => {
                useCirrus();

                return <div>nope</div>;
            });
        }).toThrow("useCirrus must be used inside <CirrusProvider />");
    });
});
