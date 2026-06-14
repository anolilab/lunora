import type { MaskColumnMetadata, MaskStrategy } from "./admin";

/**
 * Client-side re-derivation of `@cirrus/server`'s mask strategies, for the data
 * browser's **preview** toggle. This is render-only: the operator still has full
 * DB access and the stored rows are untouched — toggling on simply shows what a
 * non-privileged caller running a `.use(mask(...))` procedure would receive.
 *
 * Only `"redact"` and `"hash"` can be reproduced faithfully (their output is a
 * pure function of the cell value). A `"custom"` strategy is an opaque
 * server-side `(value, ctx) => …` closure the studio never receives, so it
 * **fails closed** to a fixed sentinel rather than guess — never leak the raw
 * value. The `"hash"` path mirrors `packages/server/src/mask/middleware.ts`'s
 * FNV-1a digest byte-for-byte so a hashed column reads identically here.
 */

/** Sentinel rendered for a `"custom"` strategy whose closure the studio can't run. */
export const CUSTOM_MASK_SENTINEL = "•••";

/**
 * FNV-1a (32-bit) digest as 8-char hex — a verbatim mirror of the server's
 * `"hash"` token (`packages/server/src/mask/middleware.ts`). Deterministic and
 * non-cryptographic: same input → same token, so the preview matches what a
 * masked query returns. `Math.imul` keeps the multiply in 32-bit space.
 */
export const fnv1aHex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and an unsigned shift; the bit ops ARE the algorithm */
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.codePointAt(index) ?? 0;
        hash = Math.imul(hash, 0x01_00_01_93);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
    /* eslint-enable no-bitwise */
};

/**
 * Apply one mask strategy to one cell value for the preview. Mirrors the server's
 * `applyStrategy` for the strategies whose output is value-derived; **fails
 * closed** for `"custom"` (and on any thrown error) by returning the sentinel.
 *
 * - `"redact"` → `null` (the server's redaction sentinel).
 * - `"hash"` → FNV-1a token (`null`/`undefined` pass through, matching the server).
 * - `"custom"` → {@link CUSTOM_MASK_SENTINEL} (closure not available client-side).
 */
export const maskValue = (value: unknown, strategy: MaskStrategy): unknown => {
    try {
        if (strategy === "redact") {
            // eslint-disable-next-line unicorn/no-null -- redaction drops the cell to the null sentinel, matching the server
            return null;
        }

        if (strategy === "hash") {
            if (value === null || value === undefined) {
                return value;
            }

            return fnv1aHex(typeof value === "string" ? value : JSON.stringify(value));
        }

        return CUSTOM_MASK_SENTINEL;
    } catch {
        return CUSTOM_MASK_SENTINEL;
    }
};

/**
 * The masked columns + toggle state threaded into the grid. `columns` maps a
 * column name to its declared strategy for the **currently selected table**;
 * `enabled` is the toolbar toggle. A column appears in the map iff it is
 * mask-covered (so the header chip is shown whenever it's present, regardless of
 * `enabled`); cell values are only rewritten when `enabled` is `true`.
 */
export interface MaskView {
    /** Column name → declared strategy, for the active table's masked columns. */
    columns: ReadonlyMap<string, MaskStrategy>;
    /** Whether the "Mask sensitive columns" toggle is on (rewrite cell values). */
    enabled: boolean;
}

/** Build a per-table `column → strategy` index from the flat `maskPolicies` metadata. */
export const maskColumnsForTable = (columns: ReadonlyArray<MaskColumnMetadata>, table: string): ReadonlyMap<string, MaskStrategy> => {
    const map = new Map<string, MaskStrategy>();

    for (const entry of columns) {
        if (entry.table === table) {
            map.set(entry.column, entry.strategy);
        }
    }

    return map;
};

/**
 * Apply the active {@link MaskView} to one cell. Returns the raw value unchanged
 * when masking is off or the column isn't mask-covered; otherwise the masked
 * form. Centralises the `enabled && covered` gate so the grid and the JSON/
 * transposed views stay consistent.
 */
export const maskCell = (value: unknown, column: string, view: MaskView): unknown => {
    if (!view.enabled) {
        return value;
    }

    const strategy = view.columns.get(column);

    return strategy === undefined ? value : maskValue(value, strategy);
};

/**
 * Apply the active {@link MaskView} across whole rows — used by the JSON and
 * transposed views, which render the row objects directly rather than per-cell.
 * Returns the rows untouched (same reference) when masking is off or no column is
 * covered, so the common unmasked path allocates nothing; otherwise each covered
 * cell is rewritten in a shallow per-row copy.
 */
export const maskRows = <Row extends Record<string, unknown>>(rows: ReadonlyArray<Row>, view: MaskView): ReadonlyArray<Row> => {
    if (!view.enabled || view.columns.size === 0) {
        return rows;
    }

    return rows.map((row) => {
        const masked: Record<string, unknown> = { ...row };

        for (const [column, strategy] of view.columns) {
            if (column in masked) {
                masked[column] = maskValue(masked[column], strategy);
            }
        }

        return masked as Row;
    });
};
