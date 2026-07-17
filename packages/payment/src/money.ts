/**
 * Money helpers, backed by dinero.js (bigint calculator).
 *
 * The public {@link Money} type stays a JSON-friendly `(minorUnits: bigint, currency)` pair — the
 * stable wire/store representation — while arithmetic, comparison, and allocation delegate to
 * dinero.js so rounding, remainder distribution (proration), and currency scales are handled by a
 * maintained library rather than hand-rolled. dinero's bigint build ships a currency object per
 * ISO-4217 code with the correct exponent (USD=2, JPY=0), so no exponent table is needed here.
 */
import { toSnapshot } from "dinero.js";
import { add, allocate, compare, dinero, subtract } from "dinero.js/bigint";

import { LunoraPaymentError } from "./errors";
import type { CurrencyCode, Money } from "./types";

// ISO-4217 minor-unit exponents (digits after the decimal). Default 2; these are the exceptions.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const exponentFor = (code: string): bigint => {
    if (ZERO_DECIMAL.has(code)) {
        return 0n;
    }

    return THREE_DECIMAL.has(code) ? 3n : 2n;
};

/** Builds a dinero bigint currency object for an ISO-4217 code. */
const currencyFor = (code: CurrencyCode) => {
    return { base: 10n, code: code.toUpperCase(), exponent: exponentFor(code.toUpperCase()) };
};

const toDinero = (value: Money) => dinero({ amount: value.minorUnits, currency: currencyFor(value.currency) });

const fromDinero = (value: ReturnType<typeof toDinero>): Money => {
    const snapshot = toSnapshot(value);

    return { currency: snapshot.currency.code, minorUnits: snapshot.amount };
};

const assertSameCurrency = (a: Money, b: Money): void => {
    if (a.currency !== b.currency) {
        throw new LunoraPaymentError("CURRENCY_MISMATCH", `cannot combine ${a.currency} with ${b.currency}`);
    }
};

/**
 * True when the currency has no minor unit (e.g. JPY).
 * @experimental
 */
export const isZeroDecimalCurrency = (currency: CurrencyCode): boolean => exponentFor(currency.toUpperCase()) === 0n;

/**
 * Construct money. Currency is normalized to uppercase; never use floats for amounts.
 * @experimental
 */
export const money = (minorUnits: bigint | number, currency: CurrencyCode): Money => {
    const units = typeof minorUnits === "bigint" ? minorUnits : BigInt(Math.trunc(minorUnits));

    return { currency: currency.toUpperCase(), minorUnits: units };
};

/**
 * `zeroMoney` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const zeroMoney = (currency: CurrencyCode): Money => money(0n, currency);

/**
 * Localized currency string for display (e.g. `$19.99`). For UI only — never for arithmetic.
 * @experimental
 */
export const formatMoney = (value: Money, locale = "en-US"): string => {
    const exponent = Number(exponentFor(value.currency.toUpperCase()));
    const amount = Number(value.minorUnits) / 10 ** exponent;

    try {
        return new Intl.NumberFormat(locale, { currency: value.currency, style: "currency" }).format(amount);
    } catch {
        // Intl throws RangeError on a non-ISO currency code — fall back to a plain rendering.
        return `${amount.toFixed(exponent)} ${value.currency}`;
    }
};

/**
 * `addMoney` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const addMoney = (a: Money, b: Money): Money => {
    assertSameCurrency(a, b);

    return fromDinero(add(toDinero(a), toDinero(b)));
};

/**
 * `subtractMoney` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const subtractMoney = (a: Money, b: Money): Money => {
    assertSameCurrency(a, b);

    return fromDinero(subtract(toDinero(a), toDinero(b)));
};

/**
 * Compares two same-currency amounts, returning -1, 0, or 1.
 * @experimental
 */
export const compareMoney = (a: Money, b: Money): -1 | 0 | 1 => {
    assertSameCurrency(a, b);

    return compare(toDinero(a), toDinero(b));
};

/**
 * Split an amount across integer ratios, distributing the remainder to the smallest unit so the
 * parts always sum back to the original. The basis for seat/proration math.
 * @experimental
 */
export const allocateMoney = (amount: Money, ratios: ReadonlyArray<bigint>): Money[] => allocate(toDinero(amount), [...ratios]).map((part) => fromDinero(part));

/**
 * `isZeroMoney` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const isZeroMoney = (a: Money): boolean => a.minorUnits === 0n;

/**
 * JSON-safe wire form of money (bigint encoded as a decimal string).
 * @experimental
 */
export interface MoneyJSON {
    readonly currency: CurrencyCode;
    readonly minorUnits: string;
}

/**
 * `toMoneyJSON` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const toMoneyJSON = (m: Money): MoneyJSON => {
    return { currency: m.currency, minorUnits: m.minorUnits.toString() };
};

/**
 * `fromMoneyJSON` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const fromMoneyJSON = (json: MoneyJSON): Money => money(BigInt(json.minorUnits), json.currency);
