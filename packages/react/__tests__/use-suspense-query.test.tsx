import type { FunctionReference } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useSuspenseQuery from "../src/use-suspense-query";
import { createMockClient } from "./mock-client";

const ref: FunctionReference = { __lunoraRef: "posts:list" };
const NO_ARGS: Record<string, unknown> = {};

const Posts = (): ReactElement => {
    const data = useSuspenseQuery<FunctionReference>(ref, NO_ARGS) as { count: number };

    return <div data-testid="display">{String(data.count)}</div>;
};

const App = ({ client }: { client: ReturnType<typeof createMockClient>["asClient"] }): ReactElement => (
    <LunoraProvider client={client}>
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
            <Posts />
        </Suspense>
    </LunoraProvider>
);

describe("useSuspenseQuery", () => {
    it("suspends until the first snapshot lands, then renders it with no undefined step", async () => {
        expect.assertions(3);

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(<App client={mock.asClient} />);

        // The fallback shows first; the component body never ran with `undefined`.
        expect(screen.getByTestId("fallback").textContent).toBe("loading");

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("1");
        });

        expect(screen.queryByTestId("fallback")).toBeNull();
    });

    it("resolves a cold mount on a live client, whose subscription cannot attach while suspended", async () => {
        expect.hasAssertions();

        const mock = createMockClient(
            () => {
                return { count: 1 };
            },
            { live: true },
        );

        render(<App client={mock.asClient} />);

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("1");
        });
    });

    it("keeps following pushed values after the first frame", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(<App client={mock.asClient} />);

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("1");
        });

        act(() => {
            mock.emit("posts:list", { count: 2 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("2");
        });
    });

    it("waits for the durable read cache before suspending on the network", async () => {
        expect.assertions(2);

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        Object.assign(mock.asClient, { isReady: false, whenReady: () => gate });

        render(<App client={mock.asClient} />);

        expect(mock.query).not.toHaveBeenCalled();

        Object.assign(mock.asClient, { isReady: true });
        release();

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("1");
        });
    });

    it("renders the durable cache's value, without the network, once it finishes loading", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        Object.assign(mock.asClient, {
            isReady: false,
            peekHydratedQueryByKey: () => {
                return { count: 9 };
            },
            whenReady: () => gate,
        });

        render(<App client={mock.asClient} />);

        Object.assign(mock.asClient, { isReady: true });
        release();

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("9");
        });

        expect(mock.query).not.toHaveBeenCalled();
    });
});
