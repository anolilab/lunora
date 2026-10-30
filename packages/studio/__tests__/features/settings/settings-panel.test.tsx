import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsPanel } from "../../../src/features/settings/settings-panel";
import type { AiOptInLevel, SettingsResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { resetShortcuts } from "../../../src/lib/shortcuts";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SETTINGS: SettingsResult = {
    deploy: { environment: "production", workerUrl: "https://app.example.workers.dev" },
    settings: [
        { bindingType: "r2", kind: "binding", name: "BUCKET", value: null },
        { kind: "var", name: "GREETING", value: "hell••••" },
        { kind: "secret", name: "API_KEY", value: "sk_l••••••••" },
    ],
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <SettingsPanel />
    </LunoraProvider>
);

const clientWith = (settings: SettingsResult, level: AiOptInLevel = "schema"): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getSettings) {
                return settings;
            }

            if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                return { available: level !== "disabled", level };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

describe("settingsPanel", () => {
    afterEach(() => {
        // The shortcut store is a module-level singleton — without this it carries
        // one test's rebinding into the next.
        resetShortcuts();
        localStorage.clear();
    });

    it("rebinds a shortcut from a keypress and persists it", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith(SETTINGS)));

        const input = await screen.findByTestId<HTMLInputElement>("set-shortcut-input-palette");

        fireEvent.keyDown(input, { key: "J" });

        expect(input.value).toBe("j");
        expect(localStorage.getItem("lunora-studio-shortcuts")).toContain('"palette":"j"');
    });

    it("refuses a modifier key, which would bind a shortcut that can never fire", async () => {
        expect.assertions(1);

        render(renderPanel(clientWith(SETTINGS)));

        const input = await screen.findByTestId<HTMLInputElement>("set-shortcut-input-console");

        fireEvent.keyDown(input, { key: "Shift" });

        expect(input.value).toBe("`");
    });

    it("restores the shipped bindings", async () => {
        expect.assertions(2);

        render(renderPanel(clientWith(SETTINGS)));

        const input = await screen.findByTestId<HTMLInputElement>("set-shortcut-input-palette");

        fireEvent.keyDown(input, { key: "j" });

        expect(input.value).toBe("j");

        fireEvent.click(screen.getByTestId("set-shortcut-reset"));

        expect(input.value).toBe("k");
    });

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

    it("shows where the deployment sits on the AI data-sharing ladder", async () => {
        expect.assertions(4);

        render(renderPanel(clientWith(SETTINGS, "schema_and_log")));

        // The level is a wrangler var with no readout anywhere else — an operator
        // whose assistant refused to read a table had nothing to look at.
        await waitFor(() => {
            expect(screen.getByTestId("set-ai-level").textContent).toBe("schema_and_log");
        });

        // Granted up to and including the current rung, withheld above it. The rung
        // marking is what makes the ladder legible rather than a list of four words.
        expect(screen.getByTestId("set-ai-tier-schema").dataset["granted"]).toBe("true");
        expect(screen.getByTestId("set-ai-tier-schema_and_log_and_data").dataset["granted"]).toBe("false");

        // And it names the var to change, which is the only actionable thing here.
        expect(screen.getByTestId("set-ai-howto").textContent).toContain("LUNORA_AI_OPT_IN");
    });

    it("still reports the level when the assistant is off, since that is when it is asked", async () => {
        expect.assertions(2);

        // `disabled` HIDES every assistant surface, so a readout living beside the
        // assistant would be unreachable to exactly the operator wondering why it
        // vanished. That is why this card is in Settings.
        render(renderPanel(clientWith(SETTINGS, "disabled")));

        await waitFor(() => {
            expect(screen.getByTestId("set-ai-level").textContent).toBe("disabled");
        });

        expect(screen.getByTestId("set-ai-tier-schema").dataset["granted"]).toBe("false");
    });

    it("offers no way to raise the level, which would make the ladder a preference", async () => {
        expect.assertions(1);

        render(renderPanel(clientWith(SETTINGS, "schema")));

        const card = await screen.findByTestId("set-ai-sharing");

        // eslint-disable-next-line testing-library/no-node-access -- asserting the ABSENCE of any control, which no role query can express as a whole-subtree claim
        expect(card.querySelectorAll('button, input, select, [role="button"]')).toHaveLength(0);
    });
});
