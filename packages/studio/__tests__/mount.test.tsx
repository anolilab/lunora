import { act, screen } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { mountStudio } from "../src/mount";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

let root: Root | undefined;
let container: HTMLElement | undefined;

const mountInto = (options: Parameters<typeof mountStudio>[0]): void => {
    container = document.createElement("div");
    document.body.append(container);

    act(() => {
        root = mountStudio({ ...options, container });
    });
};

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (): unknown => {
            return { columns: [], rows: [], total: 0 };
        },
    });

describe("mountStudio", () => {
    afterEach(() => {
        act(() => {
            root?.unmount();
        });
        root = undefined;
        container?.remove();
        container = undefined;
        sessionStorage.clear();
        localStorage.clear();
    });

    it("forwards an injected client instead of building its own", async () => {
        expect.assertions(3);

        const mock = createClient();

        mountInto({ client: mock.asClient });

        // The injected client carries its own credentials, so the studio mounts
        // straight into the app rather than the admin-token login gate…
        await expect(screen.findByTestId("dash-app-header")).resolves.toBeDefined();
        expect(screen.queryByTestId("lunora-studio-login")).toBeNull();
        // …and every admin read goes through THAT client, not a fresh one pointed
        // at the current origin with no token.
        expect(mock.query.mock.calls.length).toBeGreaterThan(0);
    });
});
