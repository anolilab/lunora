import { describe, expect, it } from "vitest";

import { money } from "../src/money";
import { bookRefundDelta, bookRefundTotal, isRefundBooked, MAX_BOOKED_REFUNDS } from "../src/refund-ledger";
import type { PaymentSession } from "../src/types";

const row = (overrides: Partial<PaymentSession> = {}): PaymentSession => {
    return {
        amount: money(1000, "USD"),
        capturedAmount: money(1000, "USD"),
        createdAt: 1,
        id: "pi_1",
        provider: "polar",
        referenceId: "user_1",
        refundedAmount: money(0, "USD"),
        state: "captured",
        updatedAt: 1,
        ...overrides,
    };
};

describe("bookRefundDelta", () => {
    it("adds a refund to the total and names it on the row", () => {
        expect.assertions(1);

        expect(bookRefundDelta(row({ refundedAmount: money(100, "USD") }), { amount: money(400, "USD"), id: "re_1" })).toStrictEqual({
            bookedRefunds: [{ amount: money(400, "USD"), id: "re_1" }],
            kind: "booked",
            refundedAmount: money(500, "USD"),
        });
    });

    it("answers duplicate for a refund the row already names, whatever its amount", () => {
        expect.assertions(2);

        const booked = row({ bookedRefunds: [{ amount: money(400, "USD"), id: "re_1" }], refundedAmount: money(400, "USD") });

        expect(bookRefundDelta(booked, { amount: money(400, "USD"), id: "re_1" })).toStrictEqual({ kind: "duplicate" });
        expect(bookRefundDelta(booked, { amount: money(1, "USD"), id: "re_1" })).toStrictEqual({ kind: "duplicate" });
    });

    it("refuses another currency and a total past the capture", () => {
        expect.assertions(2);

        expect(bookRefundDelta(row(), { amount: money(400, "EUR"), id: "re_1" })).toStrictEqual({ kind: "refused" });
        expect(bookRefundDelta(row({ refundedAmount: money(700, "USD") }), { amount: money(400, "USD"), id: "re_1" })).toStrictEqual({ kind: "refused" });
    });

    it("caps a lost dispute past the capture at the capture and books it into the dispute total", () => {
        expect.assertions(2);

        const outcome = bookRefundDelta(row({ disputedAmount: money(100, "USD"), refundedAmount: money(700, "USD") }), {
            amount: money(400, "USD"),
            id: "dp_1",
            reversal: "dispute",
        });

        expect(outcome).toMatchObject({ disputedAmount: money(500, "USD"), kind: "booked", refundedAmount: money(1000, "USD") });
        // A dispute that alone exceeds the capture is still refused.
        expect(bookRefundDelta(row(), { amount: money(1001, "USD"), id: "dp_2", reversal: "dispute" })).toStrictEqual({ kind: "refused" });
    });

    it("caps a refund marked as already moved instead of refusing it", () => {
        expect.assertions(1);

        expect(bookRefundDelta(row({ refundedAmount: money(700, "USD") }), { amount: money(400, "USD"), capAtCapture: true, id: "re_1" })).toMatchObject({
            kind: "booked",
            refundedAmount: money(1000, "USD"),
        });
    });

    it("drops the oldest entry past the cap and still books", () => {
        expect.assertions(3);

        const bookedRefunds = Array.from({ length: MAX_BOOKED_REFUNDS }, (_, index) => {
            return { amount: money(0, "USD"), id: `re_${String(index)}` };
        });
        const outcome = bookRefundDelta(row({ bookedRefunds }), { amount: money(1, "USD"), id: "re_new" });

        expect(outcome.kind === "booked" ? outcome.bookedRefunds.length : 0).toBe(MAX_BOOKED_REFUNDS);
        expect(outcome.kind === "booked" ? outcome.bookedRefunds[0]?.id : undefined).toBe("re_1");
        expect(outcome.kind === "booked" ? outcome.bookedRefunds.at(-1)?.id : undefined).toBe("re_new");
    });
});

describe("bookRefundTotal", () => {
    it("raises the row to the provider total plus its disputes, never lowers it", () => {
        expect.assertions(2);

        expect(bookRefundTotal(row({ disputedAmount: money(300, "USD"), refundedAmount: money(300, "USD") }), { total: money(200, "USD") })).toStrictEqual({
            kind: "booked",
            refundedAmount: money(500, "USD"),
        });
        expect(bookRefundTotal(row({ refundedAmount: money(600, "USD") }), { total: money(200, "USD") })).toStrictEqual({ kind: "unchanged" });
    });

    it("caps at the capture when the disputes push the sum past it, and refuses a total that alone exceeds it", () => {
        expect.assertions(2);

        expect(bookRefundTotal(row({ disputedAmount: money(500, "USD"), refundedAmount: money(500, "USD") }), { total: money(800, "USD") })).toMatchObject({
            refundedAmount: money(1000, "USD"),
        });
        expect(bookRefundTotal(row(), { total: money(1001, "USD") })).toStrictEqual({ kind: "refused" });
    });

    it("refuses another currency", () => {
        expect.assertions(1);

        expect(bookRefundTotal(row(), { total: money(100, "EUR") })).toStrictEqual({ kind: "refused" });
    });

    it("names the refunds the total is made of, and books a new id even when the total does not grow", () => {
        expect.assertions(2);

        const counted = row({ refundedAmount: money(400, "USD") });
        const outcome = bookRefundTotal(counted, { refunds: [{ amount: money(400, "USD"), refundId: "re_1" }], total: money(400, "USD") });

        expect(outcome).toStrictEqual({ bookedRefunds: [{ amount: money(400, "USD"), id: "re_1" }], kind: "booked", refundedAmount: money(400, "USD") });
        expect(
            bookRefundTotal(row({ bookedRefunds: [{ amount: money(400, "USD"), id: "re_1" }], refundedAmount: money(400, "USD") }), {
                refunds: [{ amount: money(400, "USD"), refundId: "re_1" }],
                total: money(400, "USD"),
            }),
        ).toStrictEqual({ kind: "unchanged" });
    });

    it("caps a total marked as already moved instead of refusing it", () => {
        expect.assertions(1);

        expect(bookRefundTotal(row(), { capAtCapture: true, total: money(1200, "USD") })).toStrictEqual({ kind: "booked", refundedAmount: money(1000, "USD") });
    });
});

describe("isRefundBooked", () => {
    it("reads the row's list, absent meaning none", () => {
        expect.assertions(2);

        expect(isRefundBooked(row(), "re_1")).toBe(false);
        expect(isRefundBooked(row({ bookedRefunds: [{ amount: money(1, "USD"), id: "re_1" }] }), "re_1")).toBe(true);
    });
});
