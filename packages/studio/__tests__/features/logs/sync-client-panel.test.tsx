import type { ClientDebugSnapshot } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SyncClientPanel from "../../../src/features/logs/sync-client-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const snapshot = (overrides: Partial<ClientDebugSnapshot> = {}): ClientDebugSnapshot => {
    return {
        clientId: "client-1",
        closed: false,
        connectionStatus: "connected",
        pendingWrites: 0,
        shards: [],
        subscriptions: [],
        ...overrides,
    };
};

// The panel reads its client from context via `useLunora`, so a provider is
// required even though the snapshot is injected through the `read` prop.
const renderPanel = (mock: MockClientHooks, read: () => ClientDebugSnapshot) => (
    <LunoraProvider client={mock.asClient}>
        <SyncClientPanel read={read} />
    </LunoraProvider>
);

describe("syncClientPanel", () => {
    it("shows the reading state before the first snapshot resolves", () => {
        expect.assertions(1);

        // `read` is invoked by an async query, so the very first synchronous render
        // (before the microtask resolves) is the loading EmptyState.
        render(renderPanel(createMockClient(), () => snapshot()));

        expect(screen.getByText("Reading the sync client's state…")).toBeDefined();
    });

    it("renders the connection status and both empty states when there are no shards or subscriptions", async () => {
        expect.assertions(3);

        render(renderPanel(createMockClient(), () => snapshot({ connectionStatus: "connected" })));

        await screen.findByText("connected");

        expect(screen.getByText("No shard connection has been opened yet.")).toBeDefined();
        expect(screen.getByText("This client holds no live queries or shapes.")).toBeDefined();
        expect(screen.getByText("connected")).toBeDefined();
    });

    it("renders a row per shard and per subscription with the watermark and ack state", async () => {
        expect.assertions(5);

        const read = () =>
            snapshot({
                pendingWrites: 3,
                shards: [{ confirmedMutationWatermark: 42, hasSocket: true, shardKey: "room-1", wasEverConnected: true, wsState: "open" }],
                subscriptions: [
                    {
                        acked: true,
                        functionPath: "messages:list",
                        id: "sub-1",
                        kind: "query",
                        pendingOptimisticLayers: 2,
                        serverCursor: 99,
                        shardKey: "room-1",
                        subscriberCount: 1,
                    },
                ],
            });

        render(renderPanel(createMockClient(), read));

        // The shard's function path in the subscriptions table appears once the snapshot lands.
        await screen.findByText("messages:list");

        expect(screen.getByText("room-1")).toBeDefined();
        // Confirmed watermark — the number to check first for a stuck overlay.
        expect(screen.getByText("42")).toBeDefined();
        // Pending optimistic layers on the subscription row.
        expect(screen.getByText("2")).toBeDefined();
        // The pending-writes badge.
        expect(screen.getByText("3 pending writes")).toBeDefined();
        // Cursor rendered on the subscription row.
        expect(screen.getByText("99")).toBeDefined();
    });

    it("renders the default-shard placeholder for a shard with no key", async () => {
        expect.assertions(1);

        const read = () =>
            snapshot({
                shards: [{ confirmedMutationWatermark: 0, hasSocket: false, shardKey: undefined, wasEverConnected: false, wsState: "closed" }],
            });

        render(renderPanel(createMockClient(), read));

        await screen.findByText("(default)");

        expect(screen.getByText("(default)")).toBeDefined();
    });
});
