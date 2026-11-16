import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MemoryPaymentStore } from "../src/store";
import applyWebhookAction from "../src/sync";
import type { Subscription, WebhookAction } from "../src/types";

/**
 * Model-based checks over random subscription webhook histories. Each history is replayed through
 * `applyWebhookAction` on one fresh store, with event times that only move forward (`advance: 0`
 * deliberately produces ties, which the staleness rule treats differently from strictly newer events).
 */

const EVENT_TYPES = ["subscription.active", "subscription.past_due", "subscription.paused", "subscription.canceled", "subscription.updated"] as const;

type EventType = (typeof EVENT_TYPES)[number];

interface Step {
    advance: number;
    cancelAtPeriodEnd: boolean | undefined;
    quantity: number | undefined;
    type: EventType;
}

/** The state each event type targets; `subscription.updated` carries no target. */
const TARGET_BY_TYPE: Partial<Record<EventType, string>> = {
    "subscription.active": "active",
    "subscription.canceled": "canceled",
    "subscription.past_due": "past_due",
    "subscription.paused": "paused",
};

const stepArbitrary: fc.Arbitrary<Step> = fc.record({
    advance: fc.integer({ max: 5, min: 0 }),
    cancelAtPeriodEnd: fc.option(fc.boolean(), { nil: undefined }),
    quantity: fc.option(fc.integer({ max: 10, min: 1 }), { nil: undefined }),
    type: fc.constantFrom(...EVENT_TYPES),
});

const historyArbitrary = fc.array(stepArbitrary, { maxLength: 40 });

const SUBSCRIPTION_ID = "sub_1";

const toAction = (step: Step, eventId: string, occurredAt: number): WebhookAction => {
    return {
        eventId,
        occurredAt,
        provider: "stripe",
        referenceId: "user_1",
        subscriptionId: SUBSCRIPTION_ID,
        type: step.type,
        ...(step.quantity === undefined ? {} : { quantity: step.quantity }),
        ...(step.cancelAtPeriodEnd === undefined ? {} : { cancelAtPeriodEnd: step.cancelAtPeriodEnd }),
    };
};

const applyStep = async (store: MemoryPaymentStore, action: WebhookAction) => {
    const before = await store.getSubscription("stripe", SUBSCRIPTION_ID);
    const result = await applyWebhookAction(store, action);
    const after = await store.getSubscription("stripe", SUBSCRIPTION_ID);

    return { after, before, result };
};

/** An event aimed at the state the row is already in (and the row is not canceled). */
const isSameStateEvent = (step: Step, before: Subscription | undefined): boolean =>
    before !== undefined && before.state !== "canceled" && TARGET_BY_TYPE[step.type] === before.state;

const isCanceledTerminal = (before: Subscription | undefined, after: Subscription | undefined): boolean =>
    before?.state === "canceled" && after?.state !== "canceled";

const isRewound = (before: Subscription | undefined, after: Subscription | undefined): boolean =>
    before?.lastEventAt !== undefined && after?.lastEventAt !== undefined && after.lastEventAt < before.lastEventAt;

/** A self-loop is not an illegal edge; only the staleness guard may refuse it (an entitling tie fails closed). */
const isRefusedSameState = (step: Step, before: Subscription | undefined, reason: string | undefined): boolean =>
    isSameStateEvent(step, before) && reason === "illegal_transition";

/** A same-state or metadata update that was applied must have merged its quantity. */
const isDroppedMerge = (step: Step, before: Subscription | undefined, applied: boolean, after: Subscription | undefined): boolean =>
    applied && step.quantity !== undefined && (isSameStateEvent(step, before) || step.type === "subscription.updated") && after?.quantity !== step.quantity;

/** Replay the history, returning false at the first step that breaks an invariant. */
const replay = async (history: ReadonlyArray<Step>): Promise<boolean> => {
    const store = new MemoryPaymentStore();
    let now = 1000;

    for (const [index, step] of history.entries()) {
        now += step.advance;

        // eslint-disable-next-line no-await-in-loop -- events are applied in order; each must observe the row the previous one left
        const { after, before, result } = await applyStep(store, toAction(step, `e${String(index)}`, now));

        if (
            isCanceledTerminal(before, after) ||
            isRewound(before, after) ||
            isRefusedSameState(step, before, result.reason) ||
            isDroppedMerge(step, before, result.applied, after)
        ) {
            return false;
        }
    }

    return true;
};

describe("applyWebhookAction properties", () => {
    it("keeps canceled terminal, never rewinds lastEventAt, and merges same-state updates", async () => {
        expect.assertions(1);

        const result = await fc.check(fc.asyncProperty(historyArbitrary, replay), { numRuns: 200 });

        expect(result.failed, fc.stringify(result.counterexample)).toBe(false);
    });
});
