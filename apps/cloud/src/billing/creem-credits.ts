/**
 * Creem credits-ledger adapter (GAPS.md C3 follow-up) — the concrete
 * {@link CreditsLedgerPort} over Creem's first-party `customerCredits` API.
 * Account ids are resolved through an injected lookup (the platform stores
 * each org's credits-account id at first purchase), so the adapter never
 * needs Creem's paginated account listing. Structural client type, same
 * pattern as the payment adapter: a real `Creem` instance satisfies it.
 *
 * Credit amounts cross the wire as strings (Creem uses bigint-safe strings);
 * platform credits are integer cents, so `String(n)`/`parseInt` round-trips
 * exactly.
 */

import type { CreditsLedgerPort } from "./overage";

interface CreditDebitRequest {
    amount: string;
    /** Idempotency link — Creem dedupes by it; ours encodes org+period+watermark. */
    reference: string;
}

/** The `customerCredits` surface this adapter uses; a real `Creem` instance satisfies it. */
export interface CreemCreditsClientLike {
    customerCredits: {
        createAccount: (request: { customerId: string; initialBalance?: string }) => Promise<{ id: string }>;
        creditAccount: (id: string, request: CreditDebitRequest) => Promise<unknown>;
        debitAccount: (id: string, request: CreditDebitRequest) => Promise<unknown>;
        getAccountBalance: (id: string) => Promise<{ balance: string }>;
    };
}

export interface CreemCreditsLedgerOptions {
    client: CreemCreditsClientLike;
    /** The org's credits-account id (stored at first purchase), or null when none exists yet. */
    resolveAccountId: (organizationId: string) => Promise<null | string>;
}

/** Build the {@link CreditsLedgerPort} the overage reconciliation drives. */
export const createCreemCreditsLedger = (options: CreemCreditsLedgerOptions): CreditsLedgerPort => {
    return {
        balance: async (organizationId) => {
            const accountId = await options.resolveAccountId(organizationId);

            if (!accountId) {
                return null;
            }

            const { balance } = await options.client.customerCredits.getAccountBalance(accountId);
            const parsed = Number.parseInt(balance, 10);

            return Number.isFinite(parsed) ? parsed : 0;
        },
        debit: async (organizationId, credits, reference) => {
            const accountId = await options.resolveAccountId(organizationId);

            if (!accountId) {
                throw new Error(`no credits account for organization ${organizationId}`);
            }

            await options.client.customerCredits.debitAccount(accountId, { amount: String(credits), reference });
        },
    };
};

export interface CreditPurchase {
    /** Existing credits-account id, when the org already has one. */
    accountId?: null | string;
    credits: number;
    /** The org's Creem customer id (from the payments `customers` table). */
    customerId: string;
    /** Idempotency link — use the Creem payment/checkout id of the pack purchase. */
    reference: string;
}

/**
 * Apply a credit-pack purchase (driven off the billing webhook): credit the
 * org's account, creating it seeded with the purchased balance on first
 * purchase. Returns the account id for the caller to persist on the org.
 */
export const applyCreditPurchase = async (client: CreemCreditsClientLike, purchase: CreditPurchase): Promise<{ accountId: string }> => {
    if (!purchase.accountId) {
        const account = await client.customerCredits.createAccount({ customerId: purchase.customerId, initialBalance: String(purchase.credits) });

        return { accountId: account.id };
    }

    await client.customerCredits.creditAccount(purchase.accountId, { amount: String(purchase.credits), reference: purchase.reference });

    return { accountId: purchase.accountId };
};
