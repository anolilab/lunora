import type { FunctionReference } from "@lunora/client";
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { lunoraQueryKey } from "../src/query-key";
import { prefetchQuery } from "../src/server";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

const REF: FunctionReference = { __lunoraRef: "items:byValue" };

/** The server's answer names the arg it actually received, so a shared cache entry shows up as a wrong label. */
const label = (args: unknown): string => {
    const { v } = args as { v: unknown };

    if (typeof v === "bigint") {
        return `bigint:${String(v)}`;
    }

    if (v instanceof Date) {
        return `date:${String(v.getTime())}`;
    }

    if (typeof v === "number" && Number.isNaN(v)) {
        return "nan";
    }

    if (Object.is(v, -0)) {
        return "negzero";
    }

    return `json:${JSON.stringify(v)}`;
};

const Show = ({ id, value }: { id: string; value: unknown }): ReactElement => {
    const data = useQuery(REF as FunctionReference<"query", { v: unknown }, string>, { v: value });

    return <div data-testid={id}>{data ?? "loading"}</div>;
};

const renderPair = async (a: unknown, b: unknown): Promise<[string, string]> => {
    const mock = createMockClient((_ref, args) => label(args));

    render(
        <LunoraProvider client={mock.asClient}>
            <Show id="a" value={a} />
            <Show id="b" value={b} />
        </LunoraProvider>,
    );

    await waitFor(() => {
        expect(screen.getByTestId("a").textContent).not.toBe("loading");
        expect(screen.getByTestId("b").textContent).not.toBe("loading");
    });

    return [screen.getByTestId("a").textContent ?? "", screen.getByTestId("b").textContent ?? ""];
};

describe("useQuery — args JSON cannot tell apart", () => {
    it("gives NaN and null their own cache entries", async () => {
        expect.hasAssertions();

        await expect(renderPair(Number.NaN, null)).resolves.toStrictEqual(["nan", "json:null"]);
    });

    it("gives -0 and 0 their own cache entries", async () => {
        expect.hasAssertions();

        await expect(renderPair(-0, 0)).resolves.toStrictEqual(["negzero", "json:0"]);
    });

    it("gives a Date and its ISO string their own cache entries", async () => {
        expect.hasAssertions();

        const date = new Date(0);

        await expect(renderPair(date, date.toISOString())).resolves.toStrictEqual(["date:0", `json:"${date.toISOString()}"`]);
    });

    it("renders a bigint arg instead of throwing", async () => {
        expect.hasAssertions();

        const mock = createMockClient((_ref, args) => label(args));

        render(
            <LunoraProvider client={mock.asClient}>
                <Show id="a" value={5n} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("a").textContent).toBe("bigint:5");
        });
    });
});

describe("lunoraQueryKey — every QueryClient hashes it the same way", () => {
    it("setQueryData / getQueryData keep NaN, null, -0, 0, a Date and a bigint apart", () => {
        expect.hasAssertions();

        const queryClient = new QueryClient();
        const values: unknown[] = [Number.NaN, null, -0, 0, new Date(0), new Date(0).toISOString(), 5n];

        for (const value of values) {
            queryClient.setQueryData(lunoraQueryKey(REF, { v: value }, undefined), label({ v: value }));
        }

        for (const value of values) {
            expect(queryClient.getQueryData(lunoraQueryKey(REF, { v: value }, undefined))).toBe(label({ v: value }));
        }
    });

    it("invalidates exactly the entry for the given args", async () => {
        expect.hasAssertions();

        const queryClient = new QueryClient();

        queryClient.setQueryData(lunoraQueryKey(REF, { v: Number.NaN }, undefined), "nan");
        queryClient.setQueryData(lunoraQueryKey(REF, { v: null }, undefined), "null");

        await queryClient.invalidateQueries({ exact: true, queryKey: lunoraQueryKey(REF, { v: Number.NaN }, undefined) });

        expect(queryClient.getQueryState(lunoraQueryKey(REF, { v: Number.NaN }, undefined))?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(lunoraQueryKey(REF, { v: null }, undefined))?.isInvalidated).toBe(false);
    });

    it("a server prefetch of a wire-typed arg survives dehydrate → hydrate under the key useQuery reads", async () => {
        expect.hasAssertions();

        const mock = createMockClient((_ref, args) => label(args));
        const server = new QueryClient();

        await prefetchQuery(server, mock.asClient, REF, { v: Number.NaN });
        await prefetchQuery(server, mock.asClient, REF, { v: 5n });

        const browser = new QueryClient();

        // The dehydrated state crosses the server/browser boundary as JSON,
        // which a key holding a raw bigint arg could not do.
        const wire = JSON.stringify(dehydrate(server));

        hydrate(browser, JSON.parse(wire) as unknown);

        expect(browser.getQueryData(lunoraQueryKey(REF, { v: Number.NaN }, undefined))).toBe("nan");
        expect(browser.getQueryData(lunoraQueryKey(REF, { v: null }, undefined))).toBeUndefined();
        expect(browser.getQueryData(lunoraQueryKey(REF, { v: 5n }, undefined))).toBe("bigint:5");
    });
});
