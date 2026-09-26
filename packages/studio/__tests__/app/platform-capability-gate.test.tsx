import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { openCommandPalette } from "../../src/app/command-palette";
import { Studio } from "../../src/app/studio";
import type { StudioPlatform } from "../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import type { MockClientHooks } from "../mock-client";
import { createMockClient } from "../mock-client";

/** The slice of `NODE_CAPABILITIES` the gated tabs read — the worker sends the whole level map. */
const NODE: StudioPlatform = {
    features: {
        agents: "unsupported",
        analytics: "unsupported",
        containers: "unsupported",
        mail: "unsupported",
        pointInTimeRecovery: "unsupported",
        queues: "emulated",
        vectorStore: "unsupported",
        workflows: "emulated",
    },
    id: "node",
    name: "Node",
};

const CLOUDFLARE: StudioPlatform = {
    features: {
        agents: "emulated",
        analytics: "native",
        containers: "native",
        mail: "emulated",
        pointInTimeRecovery: "native",
        queues: "native",
        vectorStore: "native",
        workflows: "native",
    },
    id: "cloudflare",
    name: "Cloudflare",
};

const UNSUPPORTED_ON_NODE = ["pitr", "agents", "vectors", "containers", "analytics", "mail"] as const;

const createClient = (platform?: StudioPlatform): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.studioFeatures) {
                return {
                    analytics: true,
                    auth: true,
                    containers: true,
                    flags: true,
                    kv: true,
                    mail: true,
                    notifications: true,
                    payments: true,
                    platform,
                    queues: true,
                    scheduler: true,
                    storage: true,
                    vectors: true,
                    workflows: true,
                };
            }

            if (reference === ADMIN_FUNCTIONS.getSecurityAudit) {
                return { findings: [] };
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return { functions: [], sinceMs: 0 };
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 1 }];
            }

            return { columns: [], rows: [], total: 0 };
        },
    });

const renderStudio = (mock: MockClientHooks, { dataEditable, schemaEditable }: { dataEditable?: boolean; schemaEditable?: boolean } = {}) =>
    render(
        <LunoraProvider client={mock.asClient}>
            <Studio dataEditable={dataEditable} schemaEditable={schemaEditable} />
        </LunoraProvider>,
    );

/** Wait until the studioFeatures RPC has settled and the studio knows which host it is talking to. */
const settled = async (platform: StudioPlatform): Promise<void> => {
    await waitFor(() => {
        expect(screen.getByTestId("lunora-studio").dataset.platform).toBe(platform.id);
    });
};

describe("platform capability gate", () => {
    afterEach(() => {
        globalThis.history.pushState({}, "", "/");
    });

    it("marks every tab a Node worker rates unsupported as unavailable, with the reason", async () => {
        expect.hasAssertions();

        renderStudio(createClient(NODE));
        await settled(NODE);

        for (const tab of UNSUPPORTED_ON_NODE) {
            const item = screen.getByTestId(`dash-tab-${tab}`);

            expect(item.dataset.unsupported).toBe("true");
            expect(item.getAttribute("title")).toContain("Node");
        }

        // Emulated is still a working surface — shown normally.
        expect(screen.getByTestId("dash-tab-workflows").dataset.unsupported).toBeUndefined();
        expect(screen.getByTestId("dash-tab-queues").dataset.unsupported).toBeUndefined();
    });

    it("shows the same tabs as available on a Cloudflare worker", async () => {
        expect.hasAssertions();

        renderStudio(createClient(CLOUDFLARE));
        await settled(CLOUDFLARE);

        for (const tab of UNSUPPORTED_ON_NODE) {
            expect(screen.getByTestId(`dash-tab-${tab}`).dataset.unsupported).toBeUndefined();
        }
    });

    it("renders the reason instead of the PITR panel on a direct link to /pitr on Node", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/pitr");
        const mock = createClient(NODE);

        renderStudio(mock);

        const notice = await screen.findByTestId("dash-unsupported");

        expect(notice.textContent).toContain("Node");
        // Stays on the URL the operator typed rather than bouncing to Home.
        expect(globalThis.location.pathname).toBe("/pitr");
        // The panel never mounted, so its RPC — the one answering PITR_UNAVAILABLE — was never issued.
        expect(mock.query.mock.calls.some(([reference]) => (reference as { __lunoraRef?: string }).__lunoraRef === ADMIN_FUNCTIONS.getPitrBookmark)).toBe(
            false,
        );
    });

    it("renders the PITR panel on a direct link to /pitr on Cloudflare", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/pitr");
        renderStudio(createClient(CLOUDFLARE));
        await settled(CLOUDFLARE);

        await expect(screen.findByTestId("lunora-pitr")).resolves.toBeDefined();
        expect(screen.queryByTestId("dash-unsupported")).toBeNull();
    });

    it("leaves unsupported panels out of the command palette on Node", async () => {
        expect.hasAssertions();

        renderStudio(createClient(NODE));
        await settled(NODE);

        act(() => {
            openCommandPalette();
        });

        const list = within(await screen.findByTestId("dash-command-list"));

        expect(list.queryByText("Time Travel")).toBeNull();
        expect(list.queryByText("Agents")).toBeNull();
        // A supported page is still offered.
        expect(list.getByText("Workflows")).toBeDefined();
    });

    it("offers the same panels in the command palette on Cloudflare", async () => {
        expect.hasAssertions();

        renderStudio(createClient(CLOUDFLARE));
        await settled(CLOUDFLARE);

        act(() => {
            openCommandPalette();
        });

        const list = within(await screen.findByTestId("dash-command-list"));

        expect(list.getByText("Time Travel")).toBeDefined();
        expect(list.getByText("Agents")).toBeDefined();
    });
});

describe("generate rows gate", () => {
    afterEach(() => {
        globalThis.history.pushState({}, "", "/");
    });

    it("hides Generate rows when the host serves no seed endpoint (editable, but not a dev host)", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/data");
        renderStudio(createClient(CLOUDFLARE), { dataEditable: true });

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-add-row");

        expect(screen.queryByTestId("db-generate-rows")).toBeNull();
    });

    it("shows Generate rows on a dev host", async () => {
        expect.hasAssertions();

        globalThis.history.pushState({}, "", "/data");
        renderStudio(createClient(CLOUDFLARE), { dataEditable: true, schemaEditable: true });

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await expect(screen.findByTestId("db-generate-rows")).resolves.toBeDefined();
    });
});
