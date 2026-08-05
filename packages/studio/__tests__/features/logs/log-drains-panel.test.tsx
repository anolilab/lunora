import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import LogDrainsPanel from "../../../src/features/logs/log-drains-panel";

describe("logDrainsPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the destination cards and the Cloudflare deep link", () => {
        expect.assertions(2);

        render(<LogDrainsPanel />);

        const cards = screen.getAllByTestId("drain-card");

        // Logpush, Tail Workers, Workers Logs.
        expect(cards).toHaveLength(3);
        expect(screen.getByTestId("drain-cf-link").getAttribute("href")).toContain("observability");
    });

    it("copies a destination's setup snippet via the copy button", () => {
        expect.assertions(1);

        const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

        vi.stubGlobal("navigator", { clipboard: { writeText } });

        render(<LogDrainsPanel />);

        fireEvent.click(screen.getByTestId("drain-copy-logpush"));

        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"logpush": true'));
    });

    it("pOSTs a sample envelope to the webhook URL and shows the delivered result", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, status: 200 } as Response);

        vi.stubGlobal("fetch", fetchMock);

        render(<LogDrainsPanel />);

        fireEvent.change(screen.getByTestId("drain-webhook-url"), { target: { value: "https://collector.test/logs" } });
        fireEvent.click(screen.getByTestId("drain-webhook-test"));

        const result = await screen.findByTestId("drain-webhook-result");

        expect(result.textContent).toContain("200");

        expect(fetchMock).toHaveBeenCalledWith(
            "https://collector.test/logs",
            expect.objectContaining({ headers: { "Content-Type": "application/json" }, method: "POST" }),
        );

        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<string, unknown>;

        expect(body).toMatchObject({ source: "lunora", type: "request" });
    });

    it("surfaces a fetch failure in the result area", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));

        vi.stubGlobal("fetch", fetchMock);

        render(<LogDrainsPanel />);

        fireEvent.change(screen.getByTestId("drain-webhook-url"), { target: { value: "https://collector.test/logs" } });
        fireEvent.click(screen.getByTestId("drain-webhook-test"));

        await waitFor(() => {
            const result = screen.getByTestId("drain-webhook-result");

            if (!result.textContent?.includes("network down")) {
                throw new Error("error result not shown yet");
            }
        });

        expect(screen.getByTestId("drain-webhook-result").textContent).toContain("network down");
    });
});
