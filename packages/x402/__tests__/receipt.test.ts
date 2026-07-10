import type { ProcessSettleSuccessResponse } from "@x402/core/http";
import { describe, expect, it, vi } from "vitest";

import { reportReceipt } from "../src/charge/middleware";
import type { X402Receipt } from "../src/charge/receipt";
import { toPaymentEventRow, toReceipt } from "../src/charge/receipt";

/** A realistic successful settlement result, overridable per test. */
const settlement = (overrides: Partial<ProcessSettleSuccessResponse> = {}): ProcessSettleSuccessResponse => {
    return {
        headers: { "X-PAYMENT-RESPONSE": "eyJ9" },
        network: "eip155:8453",
        payer: "0xPAYER000000000000000000000000000000000000",
        requirements: {
            amount: "50000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            extra: {},
            maxTimeoutSeconds: 60,
            network: "eip155:8453",
            payTo: "0xMERCHANT0000000000000000000000000000000000",
            scheme: "exact",
        },
        success: true,
        transaction: "0xTX00000000000000000000000000000000000000000000000000000000000000",
        ...overrides,
    };
};

describe("toReceipt", () => {
    it("normalises a settlement into a stable receipt", () => {
        const receipt = toReceipt(settlement(), { resource: "reports:latest", ts: 1_700_000_000_000 });

        expect(receipt).toStrictEqual({
            amount: "50000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            from: "0xPAYER000000000000000000000000000000000000",
            network: "eip155:8453",
            resource: "reports:latest",
            to: "0xMERCHANT0000000000000000000000000000000000",
            ts: 1_700_000_000_000,
            tx: "0xTX00000000000000000000000000000000000000000000000000000000000000",
        } satisfies X402Receipt);
    });

    it("prefers the actually-settled amount over the route requirement (upto scheme)", () => {
        const receipt = toReceipt(settlement({ amount: "12345" }), { resource: "r", ts: 1 });

        // `settlement.amount` (partial settlement) wins over `requirements.amount`.
        expect(receipt.amount).toBe("12345");
    });

    it("falls back to the required amount when settlement omits one (exact scheme)", () => {
        const receipt = toReceipt(settlement({ amount: undefined }), { resource: "r", ts: 1 });

        expect(receipt.amount).toBe("50000");
    });

    it("carries an undefined payer through as an undefined `from`", () => {
        const receipt = toReceipt(settlement({ payer: undefined }), { resource: "r", ts: 1 });

        expect(receipt.from).toBeUndefined();
    });
});

describe("toPaymentEventRow", () => {
    it("shapes a receipt as a @lunora/payment `events` row keyed on the tx hash", () => {
        const receipt = toReceipt(settlement(), { resource: "reports:latest", ts: 1_700_000_000_000 });

        expect(toPaymentEventRow(receipt)).toStrictEqual({
            processedAt: 1_700_000_000_000,
            provider: "x402",
            providerEventId: "0xTX00000000000000000000000000000000000000000000000000000000000000",
            type: "x402.settled",
        });
    });
});

describe("reportReceipt", () => {
    it("fires the sink with the normalised receipt for the given resource", () => {
        const sink = vi.fn<(receipt: X402Receipt) => void>();

        reportReceipt(sink, settlement(), "reports:latest");

        expect(sink).toHaveBeenCalledTimes(1);

        const receipt = sink.mock.calls[0]?.[0] as X402Receipt;

        expect(receipt.resource).toBe("reports:latest");
        expect(receipt.tx).toBe("0xTX00000000000000000000000000000000000000000000000000000000000000");
        expect(receipt.amount).toBe("50000");
        expect(typeof receipt.ts).toBe("number");
    });

    it("is a no-op when no sink is configured", () => {
        expect(() => {
            reportReceipt(undefined, settlement(), "r");
        }).not.toThrow();
    });

    it("swallows a synchronous sink throw — a reporting failure must not withhold the paid resource", () => {
        const sink = vi.fn<(receipt: X402Receipt) => void>(() => {
            throw new Error("sink exploded");
        });

        expect(() => {
            reportReceipt(sink, settlement(), "r");
        }).not.toThrow();
        expect(sink).toHaveBeenCalledTimes(1);
    });

    it("swallows a rejected async sink without surfacing the rejection", async () => {
        const sink = vi.fn<(receipt: X402Receipt) => Promise<void>>(() => Promise.reject(new Error("async sink down")));

        expect(() => {
            reportReceipt(sink, settlement(), "r");
        }).not.toThrow();

        // Let the swallowing `.catch` settle; an unhandled rejection here would fail the run.
        await Promise.resolve();

        expect(sink).toHaveBeenCalledTimes(1);
    });
});
