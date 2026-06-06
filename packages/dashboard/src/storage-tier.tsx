import type { CSSProperties, ReactElement } from "react";

/**
 * The two storage tiers a Cirrus table can live in. The whole point of this
 * module is to make the distinction legible in the dashboard so an operator
 * never has to guess where a given table's rows actually are. `shard` tables are
 * per-shard-key SQLite inside a Durable Object (`.shardBy(...)`), browsed one
 * shard at a time; `global` tables are a single D1 table shared across every
 * shard and tenant (`.global()`), and include the auth tables.
 */
type StorageTier = "global" | "shard";

interface TierMeta {
    /** Precomputed badge style (base + this tier's accent), hoisted per tier. */
    readonly badgeStyle: CSSProperties;
    /** Accent colour for the badge dot + border. */
    readonly color: string;
    /** Precomputed dot style (base + this tier's accent), hoisted per tier. */
    readonly dotStyle: CSSProperties;
    /** One-line explanation shown beneath a panel header. */
    readonly hint: string;
    /** Short pill label. */
    readonly label: string;
    /** Hover/tooltip text — the long-form of the label. */
    readonly title: string;
}

const BADGE_BASE_STYLE: CSSProperties = {
    alignItems: "center",
    border: "1px solid",
    borderRadius: 999,
    display: "inline-flex",
    fontSize: 12,
    fontWeight: 600,
    gap: 6,
    lineHeight: 1.4,
    padding: "1px 8px",
};
const DOT_BASE_STYLE: CSSProperties = { borderRadius: "50%", display: "inline-block", height: 7, width: 7 };
const HINT_STYLE: CSSProperties = { color: "#57606a", fontSize: 12, lineHeight: 1.5, margin: "4px 0 0" };
const HEADER_STYLE: CSSProperties = { margin: "0 0 12px" };

/** Build a tier's metadata, precomputing its colour-dependent styles once. */
const makeTier = (color: string, label: string, title: string, hint: string): TierMeta => {
    return {
        badgeStyle: { ...BADGE_BASE_STYLE, borderColor: color, color },
        color,
        dotStyle: { ...DOT_BASE_STYLE, backgroundColor: color },
        hint,
        label,
        title,
    };
};

/** Single source of truth for the per-tier copy, colour, and styles. */
const TIER_META: Record<StorageTier, TierMeta> = {
    global: makeTier(
        "#8250df",
        "Global · D1",
        "Global table — a single D1 table shared across all shards",
        "Declared .global() and stored once in Cloudflare D1, shared across every shard and tenant. Auth tables (user, session, …) live here too.",
    ),
    shard: makeTier(
        "#0969da",
        "Shard-local",
        "Shard-local table — per-shard SQLite inside a Durable Object",
        "Stored per shard key in a Durable Object's SQLite (.shardBy(...)). You are viewing one shard at a time — change the shard key to inspect another.",
    ),
};

/**
 * A small pill that names a table's storage tier, colour-coded and with a
 * tooltip. Pure presentational; pair it with {@link StorageTierHint} for the
 * one-line explanation.
 */
const StorageTierBadge = ({ tier }: { readonly tier: StorageTier }): ReactElement => {
    const meta = TIER_META[tier];

    return (
        <span data-testid={`storage-tier-${tier}`} data-tier={tier} style={meta.badgeStyle} title={meta.title}>
            <span aria-hidden="true" style={meta.dotStyle} />
            {meta.label}
        </span>
    );
};

/** The one-line, plain-language explanation of where a tier's rows live. */
const StorageTierHint = ({ tier }: { readonly tier: StorageTier }): ReactElement => (
    <p data-testid={`storage-tier-hint-${tier}`} style={HINT_STYLE}>
        {TIER_META[tier].hint}
    </p>
);

/**
 * Panel header that names a tier and explains it in one line — the badge over
 * the hint. Drop this at the top of a tier-scoped panel so the operator always
 * knows which storage tier they're looking at.
 */
const StorageTierHeader = ({ tier }: { readonly tier: StorageTier }): ReactElement => (
    <header data-testid={`storage-tier-header-${tier}`} style={HEADER_STYLE}>
        <StorageTierBadge tier={tier} />
        <StorageTierHint tier={tier} />
    </header>
);

export { StorageTierBadge, StorageTierHeader, StorageTierHint, TIER_META };
export type { StorageTier };
