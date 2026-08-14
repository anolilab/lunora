import emit from "../../finding";
import type { Lint } from "../../types";
import { PII_FIELD_NAMES } from "../helpers";

/** `column`, lowercased with every non-alphanumeric character stripped. */
const normalize = (column: string): string => column.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

/**
 * {@link PII_FIELD_NAMES}, normalized — so a column spelled with a different
 * separator or casing (`date_of_birth`, `DateOfBirth`) still matches a compound
 * entry (`dateOfBirth`) by its full name, not just a fragment of it.
 */
const NORMALIZED_PII_NAMES: ReadonlySet<string> = new Set([...PII_FIELD_NAMES].map((name) => normalize(name)));

/** Split a column name into lowercase words on camelCase boundaries and non-alphanumeric separators. */
const tokenize = (column: string): string[] =>
    column
        .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
        .split(/[^a-zA-Z0-9]+/u)
        .filter((token) => token.length > 0)
        .map((token) => token.toLowerCase());

/**
 * The {@link PII_FIELD_NAMES} entries that are a single word on their own
 * (`email`, `phone`, `ssn`, `dob`, `address`) — specific enough that any ONE
 * matching token in a compound column name (`email_address`, `homePhone`) is
 * reason enough to flag it. A compound PII name (`dateOfBirth`, `phoneNumber`,
 * `socialSecurityNumber`) is deliberately excluded here: its individual words
 * (`date`, `number`, `social`) are common enough on their own that matching them
 * as loose tokens would flag unrelated columns — a compound name is only matched
 * whole, via {@link NORMALIZED_PII_NAMES}.
 */
const PII_TOKENS: ReadonlySet<string> = new Set([...PII_FIELD_NAMES].filter((name) => tokenize(name).length === 1).map((name) => name.toLowerCase()));

/**
 * `true` when `column` names PII, judged two ways: the whole column (normalized)
 * matches a {@link PII_FIELD_NAMES} entry exactly, or one of its words matches a
 * single-word entry ({@link PII_TOKENS}). Token-based rather than the substring
 * match this replaced, which matched a PII fragment ANYWHERE in the normalized
 * string — `dob` inside `adobeAssetId`, `ssn` inside `classSnapshot` — turning
 * unrelated columns into false positives. Deliberately still conservative in the
 * other direction (not a full NLP classifier): a genuinely unusual PII column
 * name that shares no word with {@link PII_FIELD_NAMES} still slips through, and
 * that false negative is the cheaper mistake here.
 */
const isPiiColumn = (column: string): boolean => NORMALIZED_PII_NAMES.has(normalize(column)) || tokenize(column).some((token) => PII_TOKENS.has(token));

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
