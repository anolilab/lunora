import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { MailPanel } from "../../../src/features/logs/mail-panel";
import type { CapturedMail } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const ENTRIES: CapturedMail[] = [
    { capturedAt: 1_700_000_002_000, from: "noreply@x.test", html: "<p>Reset here</p>", id: "m2", subject: "Reset your password", to: "user@x.test" },
    { capturedAt: 1_700_000_001_000, from: "noreply@x.test", id: "m1", subject: "Welcome", text: "hello", to: ["a@x.test"] },
];

const createClient = (entries: CapturedMail[] = ENTRIES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getCapturedMail) {
                return { entries };
            }

            if (reference === ADMIN_FUNCTIONS.clearCapturedMail) {
                return { cleared: true };
            }

            if (reference === ADMIN_FUNCTIONS.sendTestMail) {
                return { id: "test-1" };
            }

            return undefined;
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <MailPanel />
    </LunoraProvider>
);

const calledWith = (mock: MockClientHooks, reference: string): boolean =>
    mock.query.mock.calls.some((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === reference);

const cleared = (mock: MockClientHooks): boolean => calledWith(mock, ADMIN_FUNCTIONS.clearCapturedMail);

describe("mailPanel", () => {
    it("renders the captured inbox newest-first and previews the selected message", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        const items = await screen.findAllByTestId("mail-list-item");
        const preview = await screen.findByTestId("mail-preview-html");

        // Newest first: the reset email is selected by default and previewed in a sandboxed iframe.
        expect(items[0]?.textContent).toContain("Reset your password");
        expect(preview.getAttribute("sandbox")).toBe("");
    });

    it("switches to the plain-text body when a different message is selected", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        const items = await screen.findAllByTestId("mail-list-item");

        fireEvent.click(items[1] as HTMLElement);
        fireEvent.click(screen.getByTestId("mail-tab-text"));

        const textBody = await screen.findByTestId("mail-preview-text");

        expect(textBody.textContent).toBe("hello");
    });

    it("shows the empty state when no mail has been captured", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        const empty = await screen.findByTestId("mail-empty");

        expect(empty.dataset["testid"]).toBe("mail-empty");
    });

    it("clears the inbox via the admin RPC", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        // The Clear button is disabled until the captured entries load — wait for
        // the inbox to populate before clicking, or the click is a no-op.
        await screen.findAllByTestId("mail-list-item");

        fireEvent.click(screen.getByTestId("mail-clear"));

        await waitFor(() => {
            if (!cleared(mock)) {
                throw new Error("clearCapturedMail not called yet");
            }
        });

        expect(cleared(mock)).toBe(true);
    });

    it("enables the copy-link button only when the selected message has a link", async () => {
        expect.assertions(2);

        const entries: CapturedMail[] = [
            { capturedAt: 2, html: "<p>Reset at https://app.test/reset?t=abc</p>", id: "with-link", subject: "Has link", to: "u@x.test" },
            { capturedAt: 1, id: "no-link", subject: "No link", text: "nothing here", to: "u@x.test" },
        ];

        render(renderPanel(createClient(entries)));

        // Newest (with link) is selected by default → copy enabled.
        const copyWithLink = await screen.findByTestId("mail-copy-link");

        expect(copyWithLink.hasAttribute("disabled")).toBe(false);

        // Select the link-free message → copy disabled.
        const items = await screen.findAllByTestId("mail-list-item");

        fireEvent.click(items[1] as HTMLElement);

        const copyNoLink = await screen.findByTestId("mail-copy-link");

        expect(copyNoLink.hasAttribute("disabled")).toBe(true);
    });

    it("filters the list by subject substring", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        await screen.findAllByTestId("mail-list-item");

        const search = await screen.findByTestId("mail-search");

        fireEvent.change(search, { target: { value: "welcome" } });

        const filtered = await screen.findAllByTestId("mail-list-item");

        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.textContent).toContain("Welcome");
    });

    it("sends a test email via the admin RPC then refreshes", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("mail-send-test"));

        await waitFor(() => {
            if (!calledWith(mock, ADMIN_FUNCTIONS.sendTestMail)) {
                throw new Error("sendTestMail not called yet");
            }
        });

        expect(calledWith(mock, ADMIN_FUNCTIONS.sendTestMail)).toBe(true);
    });
});
