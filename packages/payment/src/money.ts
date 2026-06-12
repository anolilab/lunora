import { CirrusPaymentError } from "./errors";
import type { CurrencyCode, Money } from "./types";

/**
 * ISO-4217 currencies with no minor unit — the integer amount is already the major unit
 * (e.g. JPY 500 = ¥500). This matches how Stripe represents zero-decimal currencies, so our
 * `minorUnits` maps 1:1 onto provider amounts without conversion.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
    "BIF",
    "CLP",
    "DJF",
    "GNF",
    "JPY",
    "KMF",
    "KRW",
    "MGA",
    "PYG",
    "RWF",
    "UGX",
    "VND",
    "VUV",
    "XAF",
    "XOF",
    "XPF",
]);

const assertSameCurrency = (a: Money, b: Money): void => {
    if (a.currency !== b.currency) {
        throw new CirrusPaymentError("CURRENCY_MISMATCH", `cannot combine ${a.currency} with ${b.currency}`);
    }
};

export const isZeroDecimalCurrency = (currency: CurrencyCode): boolean => ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());

/** Construct money. Currency is normalized to uppercase; never use floats for amounts. */
export const money = (minorUnits: bigint | number, currency: CurrencyCode): Money => {
    const units = typeof minorUnits === "bigint" ? minorUnits : BigInt(Math.trunc(minorUnits));

    return { currency: currency.toUpperCase(), minorUnits: units };
};

export const zeroMoney = (currency: CurrencyCode): Money => money(0n, currency);

export const addMoney = (a: Money, b: Money): Money => {
    assertSameCurrency(a, b);

    return money(a.minorUnits + b.minorUnits, a.currency);
};

export const subtractMoney = (a: Money, b: Money): Money => {
    assertSameCurrency(a, b);

    return money(a.minorUnits - b.minorUnits, a.currency);
};

/** Compares two same-currency amounts, returning -1, 0, or 1. */
export const compareMoney = (a: Money, b: Money): -1 | 0 | 1 => {
    assertSameCurrency(a, b);

    if (a.minorUnits < b.minorUnits) {
        return -1;
    }

    return a.minorUnits > b.minorUnits ? 1 : 0;
};

export const isZeroMoney = (a: Money): boolean => a.minorUnits === 0n;

/** JSON-safe wire form of money (bigint encoded as a decimal string). */
export interface MoneyJSON {
    readonly currency: CurrencyCode;
    readonly minorUnits: string;
}

export const toMoneyJSON = (m: Money): MoneyJSON => {
    return { currency: m.currency, minorUnits: m.minorUnits.toString() };
};

export const fromMoneyJSON = (json: MoneyJSON): Money => money(BigInt(json.minorUnits), json.currency);
