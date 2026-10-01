import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ArchitectureManifest } from "../../../../../shared/architecture-manifest";
import { EDGE_KINDS } from "../../../../../shared/architecture-manifest";
import { layoutArchitecture, linkFor, parseArchitecture } from "../../../src/features/architecture/architecture-model";
import ArchitecturePanel from "../../../src/features/architecture/architecture-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const MANIFEST: ArchitectureManifest = {
    edges: [
        { from: "function:chat_posts:post", kind: "call", to: "function:accounts_users:me" },
        { from: "function:chat_posts:post", kind: "write", to: "table:messages" },
        { from: "function:legacy:sync", kind: "read", to: "table:users" },
    ],
    nodes: [
        { id: "function:accounts_users:me", kind: "function", name: "accounts_users.me", module: "accounts" },
        { id: "function:chat_posts:post", kind: "function", name: "chat_posts.post", module: "chat" },
        { id: "function:legacy:sync", kind: "function", name: "legacy.sync" },
        { id: "table:messages", kind: "table", name: "messages", module: "chat" },
        { id: "table:users", kind: "table", name: "users", module: "accounts" },
        { id: "table:voting_votes", kind: "table", name: "voting_votes", module: "voting" },
    ],
    modules: [
        { name: "accounts", tables: ["users"] },
        { description: "Channels and messages", name: "chat", tables: ["messages"] },
        { installed: true, name: "voting", tables: ["voting_votes"] },
    ],
    unresolved: [{ file: "chat/posts", kind: "call", line: 9, reason: "the function reference is not a static api.* / internal.* chain" }],
    version: 1,
};

// Node clicks navigate via TanStack Router; stub `useNavigate` with a spy
// (hoisted so it exists when vi.mock's factory runs).
const { navigateSpy } = vi.hoisted(() => {
    return { navigateSpy: vi.fn<(link: unknown) => Promise<void>>(async () => {}) };
});

vi.mock(import("@tanstack/react-router"), () => ({ useNavigate: () => navigateSpy }) as never);

const ALL_KINDS = new Set(EDGE_KINDS);

const renderPanel = (mock: MockClientHooks, manifest?: unknown): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <ArchitecturePanel manifest={manifest} />
    </LunoraProvider>
);

describe("layoutArchitecture", () => {
    it("puts each module in its own lane and nodes outside every module in the app lane", () => {
        expect.assertions(5);

        const { edges, nodes } = layoutArchitecture(MANIFEST, { appLaneLabel: "App", componentLabel: "component", kinds: ALL_KINDS });

        expect(nodes.filter((node) => node.type === "lane").map((node) => node.id)).toStrictEqual(["lane:accounts", "lane:chat", "lane:voting", "lane:"]);
        expect(nodes.find((node) => node.id === "lane:voting")?.data.label).toBe("voting · component");
        expect(nodes.find((node) => node.id === "function:legacy:sync")?.parentId).toBe("lane:");
        expect(nodes.find((node) => node.id === "table:messages")?.parentId).toBe("lane:chat");
        expect(edges).toHaveLength(3);
    });

    it("keeps a filtered module's neighbours one edge away, and drops hidden edge kinds", () => {
        expect.assertions(2);

        const filtered = layoutArchitecture(MANIFEST, { appLaneLabel: "App", componentLabel: "component", kinds: ALL_KINDS, lane: "chat" });
        const noCalls = layoutArchitecture(MANIFEST, {
            appLaneLabel: "App",
            componentLabel: "component",
            kinds: new Set(["read", "write"] as const),
            lane: "chat",
        });

        expect(filtered.nodes.map((node) => node.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
            ["function:accounts_users:me", "function:chat_posts:post", "lane:accounts", "lane:chat", "table:messages"].toSorted((a, b) => a.localeCompare(b)),
        );
        expect(noCalls.nodes.some((node) => node.id === "function:accounts_users:me")).toBe(false);
    });
});

describe("parseArchitecture", () => {
    it("accepts a manifest and rejects anything without its arrays", () => {
        expect.assertions(2);

        expect(parseArchitecture(MANIFEST)).toBe(MANIFEST);
        expect(parseArchitecture({ nodes: [] })).toBeUndefined();
    });
});

describe("architecturePanel", () => {
    it("renders the catalog, a component badge and the unresolved list from the fetched manifest", async () => {
        expect.assertions(4);

        const mock = createMockClient({ fetchArchitecture: () => MANIFEST as unknown as Record<string, unknown> });

        render(renderPanel(mock));

        await expect(screen.findByTestId("architecture-catalog")).resolves.toBeDefined();
        expect(screen.getByTestId("architecture-module-chat").textContent).toContain("Channels and messages");
        expect(screen.getByTestId("architecture-unresolved").textContent).toContain("chat/posts:9");
        expect(screen.getByTestId("architecture-component-voting")).toBeDefined();
    });

    it("shows how to opt in when the app declares no module", async () => {
        expect.assertions(1);

        render(renderPanel(createMockClient({})));

        await expect(screen.findByTestId("architecture-empty")).resolves.toBeDefined();
    });

    it("drops an edge kind from the diagram when it is toggled off", async () => {
        expect.assertions(3);

        render(renderPanel(createMockClient({}), MANIFEST));

        const toggle = await screen.findByTestId("architecture-kind-call");

        expect(screen.getByTestId("architecture-edge-count").textContent).toBe("3 edges shown");

        fireEvent.click(toggle);

        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByTestId("architecture-edge-count").textContent).toBe("2 edges shown");
    });
});

describe("linkFor", () => {
    it("opens a table's rows and every other kind's listing tab", () => {
        expect.assertions(4);

        expect(linkFor({ id: "table:messages", kind: "table", name: "messages" })).toStrictEqual({ search: { table: "messages" }, to: "/data" });
        expect(linkFor({ id: "function:chat_posts:post", kind: "function", name: "chat_posts.post" })).toStrictEqual({ to: "/functions" });
        expect(linkFor({ id: "topic:posted", kind: "topic", name: "posted" })).toStrictEqual({ to: "/queues" });
        expect(linkFor({ id: "cron:nightly", kind: "cron", name: "nightly" })).toStrictEqual({ to: "/schedule" });
    });
});

describe("architecture diagram interactions", () => {
    it("navigates to a table's rows when its node is clicked", async () => {
        expect.assertions(1);

        render(renderPanel(createMockClient({}), MANIFEST));

        // Each member node is a real button, so Enter / Space work from the keyboard too.
        fireEvent.click(await screen.findByText("table · messages", { selector: "button" }));

        expect(navigateSpy).toHaveBeenCalledWith({ search: { table: "messages" }, to: "/data" });
    });

    it("offers PNG, SVG and JSON export", async () => {
        expect.assertions(1);

        render(renderPanel(createMockClient({}), MANIFEST));

        await expect(screen.findByTestId("architecture-export-trigger")).resolves.toBeDefined();
    });

    it("shows an error when an image export fails", async () => {
        expect.assertions(1);

        render(renderPanel(createMockClient({}), MANIFEST));

        fireEvent.click(await screen.findByTestId("architecture-export-trigger"));
        fireEvent.click(await screen.findByTestId("architecture-export-png"));

        const error = await screen.findByTestId("architecture-export-error");

        // jsdom cannot rasterise, so the real export rejects — exactly the path under test.
        expect(error.textContent).toMatch(/^Export failed: /u);
    });
});
