import { CirrusProvider } from "@cirrus/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { SettingsResult } from "../src/admin";
import { ADMIN_FUNCTIONS } from "../src/admin";
import { SettingsPanel } from "../src/settings-panel";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const SETTINGS: SettingsResult = {
    deploy: { environment: "production", workerUrl: "https://app.example.workers.dev" },
    settings: [
        { bindingType: "r2", kind: "binding", name: "BUCKET", value: null },
        { kind: "var", name: "GREETING", value: "hell••••" },
        { kind: "secret", name: "API_KEY", value: "sk_l••••••••" },
    ],
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <SettingsPanel />
    </CirrusProvider>
);

const clientWith = (settings: SettingsResult): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getSettings) {
                return settings;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

describe("settingsPanel", () => {
    it("renders one row per setting with its name, kind, and masked value", async () => {
        expect.assertions(3);

        render(renderPanel(clientWith(SETTINGS)));

        await waitFor(() => {
            if (screen.queryAllByTestId("set-row").length !== 3) {
                throw new Error("not loaded");
            }
        });

        expect(screen.getAllByTestId("set-row")).toHaveLength(3);
        // The masked secret preview is shown; the table renders it verbatim.
        expect(screen.getByText("sk_l••••••••")).toBeDefined();
        expect(screen.getByText("API_KEY")).toBeDefined();
    });

    it("shows deploy info and a Cloudflare deep-link", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith(SETTINGS)));

        await screen.findByTestId("set-deploy");

        expect(screen.getAllByTestId("set-deploy-row").length).toBeGreaterThan(0);

        const link = screen.getByTestId<HTMLAnchorElement>("set-cf-link");

        expect(link.href).toContain("dash.cloudflare.com");
    });

    it("surfaces a read failure as an error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (): unknown => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("set-error");

        expect(screen.getByTestId("set-error").textContent).toContain("ADMIN_FORBIDDEN");
    });

    it("shows an empty state when there are no vars or bindings", async () => {
        expect.assertions(1);

        render(renderPanel(clientWith({ deploy: {}, settings: [] })));

        await screen.findByTestId("set-empty");

        expect(screen.getByTestId("set-empty")).toBeDefined();
    });
});
