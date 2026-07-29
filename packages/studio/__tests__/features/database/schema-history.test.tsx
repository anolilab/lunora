import { LunoraProvider } from "@lunora/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { SchemaHistoryPanel } from "../../../src/features/database/schema-history";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/** A one-table snapshot, serialized the way the DO ledger stores it. */
const snapshotJson = (tables: string[]): string =>
    JSON.stringify({
        migrationIds: [],
        tables: Object.fromEntries(
            tables.map((name) => [name, { fields: { id: { kind: "id", optional: false } }, indexes: {}, relations: {}, shardMode: "root" }]),
        ),
        version: 1,
    });

const VERSIONS = [
    { appliedAt: 2000, hash: "bbbbbbbbbbbbbbbb", seq: 2 },
    { appliedAt: 1000, hash: "aaaaaaaaaaaaaaaa", seq: 1 },
];

const SNAPSHOTS: Record<string, string> = {
    aaaaaaaaaaaaaaaa: snapshotJson(["users"]),
    bbbbbbbbbbbbbbbb: snapshotJson(["posts", "users"]),
};

const createClient = (options: { failHistory?: boolean; versions?: typeof VERSIONS } = {}): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.schemaHistory) {
                if (options.failHistory === true) {
                    throw new Error("ADMIN_FORBIDDEN");
                }

                return { versions: options.versions ?? VERSIONS };
            }

            if (reference === ADMIN_FUNCTIONS.schemaVersion) {
                const hash = (args as { hash?: string }).hash ?? "";
                const stored = SNAPSHOTS[hash];

                return { version: stored === undefined ? undefined : { appliedAt: 0, hash, seq: 0, snapshotJson: stored } };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

/**
 * The panel keeps the selected version in the `/migrations` search params, so it
 * mounts under a real in-memory router — the same harness `table-editor.test.tsx`
 * uses for the `/data` route.
 */
const renderPanel = (mock: MockClientHooks, initialUrl = "/migrations"): ReactElement => {
    const rootRoute = createRootRoute();
    const migrationsRoute = createRoute({ component: () => <SchemaHistoryPanel />, getParentRoute: () => rootRoute, path: "/migrations" });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: [initialUrl] }), routeTree: rootRoute.addChildren([migrationsRoute]) });

    return (
        <LunoraProvider client={mock.asClient}>
            <RouterProvider router={router} />
        </LunoraProvider>
    );
};

describe("schemaHistoryPanel", () => {
    it("lists every recorded version newest-first and selects the newest by default", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        await waitFor(() => {
            expect(screen.getByTestId("sh-timeline")).toBeDefined();
        });

        // The derived selection defaults to the head of the ledger, so the page
        // opens on the most recent change rather than on nothing.
        expect(screen.getByTestId("sh-version-bbbbbbbbbbbbbbbb").className).toContain("border-s-primary");
    });

    it("diffs the selected version against its predecessor", async () => {
        expect.hasAssertions();

        render(renderPanel(createClient()));

        // The canvas and the change list are two tabs over the same diff, and the
        // canvas is the default — open the list before reading it.
        fireEvent.click(await screen.findByTestId("sh-pane-changes"));

        // v2 adds `posts` on top of v1's `users` — the change list is the shared
        // DriftChange[], the same verdict the deploy gate blocks on. Awaited via
        // `findBy` rather than asserting inside `waitFor`, which retries the
        // assertion and inflates the count.
        const changes = await screen.findByTestId("sh-changes");

        await waitFor(() => {
            expect(changes.textContent).toContain("added table posts");
        });
    });

    it("treats the first recorded version as all-new rather than diffing against nothing", async () => {
        expect.assertions(1);

        render(renderPanel(createClient({ versions: [VERSIONS[1] as (typeof VERSIONS)[number]] })));

        await waitFor(() => {
            // Case-insensitive: the verdict renders this label in a mono caption
            // that is uppercased by CSS, so asserting the exact casing of the
            // source string would break on a purely visual change.
            expect(screen.getByTestId("sh-summary").textContent?.toLowerCase()).toContain("first recorded version");
        });
    });

    it("falls back to the newest version when the URL names one that is not in the ledger", async () => {
        expect.assertions(1);

        // A pruned or mistyped `?version=` must not leave the panel selecting
        // nothing — the selection is derived, not stored, precisely for this.
        render(renderPanel(createClient(), "/migrations?version=cccccccccccccccc"));

        await waitFor(() => {
            expect(screen.getByTestId("sh-version-bbbbbbbbbbbbbbbb").className).toContain("border-s-primary");
        });
    });

    it("shows an empty state only when the ledger is genuinely empty", async () => {
        expect.assertions(1);

        render(renderPanel(createClient({ versions: [] })));

        await waitFor(() => {
            expect(screen.getByTestId("sh-empty")).toBeDefined();
        });
    });

    it("surfaces an unreachable RPC as an error, NOT as 'no versions recorded'", async () => {
        expect.assertions(2);

        // An older worker (or a missing admin token) also yields zero versions.
        // Rendering the empty state for it would assert something about the
        // database the studio does not know.
        render(renderPanel(createClient({ failHistory: true })));

        await waitFor(() => {
            expect(screen.getByTestId("sh-error")).toBeDefined();
        });

        expect(screen.queryByTestId("sh-empty")).toBeNull();
    });
});
