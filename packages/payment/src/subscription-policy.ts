/**
 * The duplicate-subscription policy, opt-in through `singleSubscriptionPerReference`. Every write that can start
 * granting access goes through {@link storeSubscription}, so the policy holds on each path that writes a row.
 */
import { LunoraPaymentError } from "./errors";
import type { PaymentStore, RevisionGuard } from "./store";
import type { ProviderId, Subscription, SubscriptionState } from "./types";

/** The states that grant access. */
const ENTITLING_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(["active", "trialing"]);

/**
 * Whether `referenceId` holds a subscription that grants access, other than `provider`/`subscriptionId`. Paused and
 * past-due rows grant nothing, so they do not block: each activation is checked when it happens.
 */
const hasOtherLiveSubscription = async (store: PaymentStore, referenceId: string, provider: ProviderId, subscriptionId: string): Promise<boolean> => {
    const subscriptions = await store.listSubscriptionsByReference(referenceId);

    return subscriptions.some(
        (subscription) => (subscription.provider !== provider || subscription.id !== subscriptionId) && ENTITLING_STATES.has(subscription.state),
    );
};

/** `refused`: the policy blocked a write that would grant access. `rejected`: the store's revision guard declined it. */
type SubscriptionWrite = "refused" | "rejected" | "written";

// Each lost bump re-reads and re-checks, and a re-check that finds another grant ends the loop, so this bounds only a
// reference under constant contention. Past it the write steps back, which fails closed.
const MAX_CLAIM_ATTEMPTS = 5;

/**
 * Write `change(row)` over the row `provider`/`id` holds now, guarded by that row's revision, and read again if a write
 * got in between. A row that no longer grants access is left as it is. Used to step a grant back, so it must not give up quietly: a row that kept granting access would leave
 * two rows granting.
 */
const rewrite = async (store: PaymentStore, provider: ProviderId, id: string, change: (row: Subscription) => Subscription): Promise<void> => {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each attempt reads what the previous one wrote, so they cannot run together
        const row = await store.getSubscription(provider, id);

        // A row a write has since moved to a state that grants nothing (canceled by a webhook) has nothing to step back.
        if (row === undefined || !ENTITLING_STATES.has(row.state)) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- see above
        if (await store.upsertSubscription(change(row), { ifRevision: row.revision })) {
            return;
        }
    }

    throw new LunoraPaymentError("INVALID_TRANSITION", `subscription "${id}" could not be stepped back from a duplicate grant; reconcile it`);
};

/**
 * What a subscription the policy refuses is stored as. The provider still bills it, but it must grant nothing and must
 * stay cancellable under the owner it asked for. A row that already granted access under a real owner keeps that owner
 * and the rest of the update applies. A stored row that grants nothing keeps its state, except a canceled one, which would
 * stop the customer cancelling. Everything else is recorded as paused: past due is a paid tier to consumers that treat it as one.
 */
const refusalRecord = (previous: Subscription | undefined, next: Subscription): Subscription => {
    if (previous !== undefined && ENTITLING_STATES.has(previous.state) && previous.referenceId.trim() !== "") {
        return { ...next, referenceId: previous.referenceId };
    }

    const keepsState = previous !== undefined && !ENTITLING_STATES.has(previous.state) && previous.state !== "canceled";

    return { ...next, state: keepsState ? previous.state : "paused" };
};

/**
 * Settle a write that has just granted access to `granted.referenceId`, and say whether it keeps granting.
 *
 * The store cannot write two subscription rows atomically, so "no other row grants, then write mine" lets two grants
 * both pass the check. The reference's counter orders them. `revision` was read BEFORE the check that found nothing, and
 * the grant's own row was written BEFORE the bump below. A bump that lands therefore proves nothing was bumped since
 * that read, and every grant that bumps later read the counter after this bump, so its check sees this write. A bump
 * that loses read the counter after the winner's, which is after the winner's row was written, so the re-check sees it
 * and the loser steps back through `demote`. One of two racing grants always keeps its access, never both.
 *
 * Between a loser's write and its `demote` both rows read as granting access. A reader in that gap sees two, which the
 * policy cannot rule out without a write that spans rows.
 */
const settleGrant = async (store: PaymentStore, granted: Subscription, revision: number, demote: () => Promise<void>): Promise<boolean> => {
    let observed = revision;

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each attempt reads what the previous one wrote, so they cannot run together
        if (await store.bumpReferenceRevision(granted.referenceId, observed)) {
            return true;
        }

        // The counter is read before the rows it vouches for, never after.
        // eslint-disable-next-line no-await-in-loop -- each attempt reads what the previous one wrote, so they cannot run together
        observed = await store.getReferenceRevision(granted.referenceId);

        // eslint-disable-next-line no-await-in-loop -- each attempt reads what the previous one wrote, so they cannot run together
        if (await hasOtherLiveSubscription(store, granted.referenceId, granted.provider, granted.id)) {
            break;
        }
    }

    await demote();

    return false;
};

/**
 * Write `next` unless the policy refuses it. A write grants access when `next` entitles and either there was no row,
 * the row did not entitle, or its owner changes. Only such a write is refused, so a duplicate row that already exists
 * does not block updates to the row it already has.
 *
 * A refused subscription is still recorded, in a state that grants nothing, so the customer can cancel it in the app
 * and the provider's later events for it find a row. A row that already granted access is left as it is.
 */
const storeSubscription = async (
    store: PaymentStore,
    singleSubscriptionPerReference: boolean,
    previous: Subscription | undefined,
    next: Subscription,
    guard?: RevisionGuard,
): Promise<SubscriptionWrite> => {
    const grantsAccess =
        ENTITLING_STATES.has(next.state) && (previous === undefined || !ENTITLING_STATES.has(previous.state) || previous.referenceId !== next.referenceId);

    if (!singleSubscriptionPerReference || !grantsAccess || next.referenceId.trim() === "") {
        return (await store.upsertSubscription(next, guard)) ? "written" : "rejected";
    }

    // Read before the check below: see `settleGrant`.
    const revision = await store.getReferenceRevision(next.referenceId);

    if (await hasOtherLiveSubscription(store, next.referenceId, next.provider, next.id)) {
        return (await store.upsertSubscription(refusalRecord(previous, next), guard)) ? "refused" : "rejected";
    }

    if (!(await store.upsertSubscription(next, guard))) {
        return "rejected";
    }

    const kept = await settleGrant(store, next, revision, () => rewrite(store, next.provider, next.id, (row) => refusalRecord(previous, row)));

    return kept ? "written" : "refused";
};

/**
 * Put back a row that was retired (set to canceled) so a plan change could move off it, once the change did not land.
 * `retired` is the canceled row as stored, `original` what it held before. Restoring grants access again, so under the
 * policy it goes through the same claim as any other grant, and a restore that loses to another grant leaves the row
 * canceled: the plan that took over keeps the access.
 */
const restoreSubscription = async (
    store: PaymentStore,
    singleSubscriptionPerReference: boolean,
    retired: Subscription,
    original: Subscription,
): Promise<void> => {
    const claims = singleSubscriptionPerReference && ENTITLING_STATES.has(original.state) && original.referenceId.trim() !== "";
    const revision = claims ? await store.getReferenceRevision(original.referenceId) : 0;

    if (claims && (await hasOtherLiveSubscription(store, original.referenceId, original.provider, original.id))) {
        return;
    }

    if (!(await store.upsertSubscription(original, { ifRevision: retired.revision })) || !claims) {
        return;
    }

    await settleGrant(store, original, revision, () =>
        rewrite(store, original.provider, original.id, (row) => {
            return { ...row, state: "canceled" };
        }),
    );
};

export { ENTITLING_STATES, hasOtherLiveSubscription, restoreSubscription, storeSubscription };
export type { SubscriptionWrite };
