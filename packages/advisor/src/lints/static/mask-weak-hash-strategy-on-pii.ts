import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * PII-shaped column-name fragments, tested against the column name with all
 * non-alphanumeric characters stripped and lowercased — so `email`, `email_address`,
 * `emailAddress`, `date_of_birth`, and `dateOfBirth` all normalize to a form this
 * matches. Deliberately conservative (substring, not a full NLP classifier):
 * false negatives (an unusual PII column name that slips through) are
 * preferable to false positives on an unrelated column.
 */
const PII_COLUMN_RE =
    /address|birthdate|creditcard|dateofbirth|dob|driverslicense|email|firstname|fullname|lastname|nationalid|passport|phone|socialsecurity|ssn|taxid/u;

/** `true` when `column`, normalized (non-alphanumeric stripped, lowercased), matches {@link PII_COLUMN_RE}. */
const isPiiColumn = (column: string): boolean => PII_COLUMN_RE.test(column.replaceAll(/[^a-z0-9]/giu, "").toLowerCase());

/**
 * Flags a `mask(policies)` column whose strategy is the literal `"hash"` and
 * whose column name matches a PII heuristic (`email`, `ssn`, `phone`, …).
 *
 * Lunora's `"hash"` mask strategy is an unsalted 32-bit FNV-1a digest — a
 * stable pseudonym for grouping/joining, deliberately **not** a confidentiality
 * control. Its narrow (~2^32) output space makes it brute-force-recoverable by
 * the very caller it is meant to mask from, and identical inputs always
 * produce identical tokens, so it also leaks cross-row/cross-tenant equality.
 * Applying it to a PII column reads as protection but isn't; `"redact"` (drop
 * to `null`) is the strategy that actually hides the value.
 *
 * Runs only when the codegen feeder supplies strategy evidence
 * (`context.maskStrategies`); a runtime caller with no evidence flags nothing.
 * A `MaskFn` (custom, non-literal) strategy carries no static signal and is
 * never recorded by the feeder, so it never reaches this lint either.
 */
const maskWeakHashStrategyOnPii: Lint = {
    categories: ["SECURITY"],
    description:
        'A `mask(policies)` column named like PII (email, SSN, phone, …) uses the `"hash"` strategy. `"hash"` is an unsalted 32-bit FNV-1a digest — brute-force-recoverable and cross-row-correlatable — not a confidentiality control, so it does not actually hide the value.',
    facing: "EXTERNAL",
    level: "WARN",
    name: "mask_weak_hash_strategy_on_pii",
    remediation:
        'Use `"redact"` instead of `"hash"` for this column — e.g. `mask({ <table>: { <column>: "redact" } })`. Reserve `"hash"` for columns where a stable, joinable pseudonym is the goal and the value itself is not sensitive.',
    run: (context) => {
        if (context.maskStrategies === undefined) {
            return [];
        }

        return context.maskStrategies
            .filter((strategy) => strategy.strategy === "hash" && isPiiColumn(strategy.column))
            .map((strategy) =>
                emit(maskWeakHashStrategyOnPii, {
                    cacheKey: `mask_weak_hash_strategy_on_pii:${strategy.file}:${strategy.line.toString()}`,
                    detail: `\`${strategy.exportName}\` in ${strategy.file} masks \`${strategy.table === "" ? strategy.column : `${strategy.table}.${strategy.column}`}\` with \`"hash"\` — its name suggests PII, and \`"hash"\` is brute-force-recoverable and leaks cross-row equality. Use \`"redact"\` instead.`,
                    metadata: { column: strategy.column, exportName: strategy.exportName, file: strategy.file, table: strategy.table },
                }),
            );
    },
    source: "static",
    title: 'Weak "hash" mask strategy on a PII column',
};

export default maskWeakHashStrategyOnPii;
