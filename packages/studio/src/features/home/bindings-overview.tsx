import { useLunora } from "@lunora/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import useStudioFeatures from "../../hooks/use-studio-features";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";

/** One binding capability rendered as a card: its label, count, name chips, and target tab. */
interface BindingGroup {
    /** The bound resource names shown as chips (namespace / bucket / index names). */
    bindings: string[];
    /** Localised card title, e.g. "KV Namespaces". */
    label: string;
    /** The studio tab this card links to (`/${tab}`). */
    tab: string;
    /** Stable test id for the card. */
    testId: string;
}

const ChevronRight = (): ReactElement => (
    <svg aria-hidden="true" className="size-4 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
        <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

/** A single binding-capability card — clickable, opening its studio tab. */
const BindingCard = ({ group }: { readonly group: BindingGroup }): ReactElement => {
    const t = useT();
    const navigate = useNavigate();

    const onOpen = (): void => {
        fireAndForget(navigate({ to: `/${group.tab}` }));
    };

    const count = group.bindings.length;

    return (
        <Card className="cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/40" data-testid={group.testId} onClick={onOpen}>
            <CardContent className="flex flex-col gap-2 py-4">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">{group.label}</span>
                    <ChevronRight />
                </div>
                <span className="text-xs text-muted-foreground">{count === 1 ? t("1 binding") : t("{count} bindings", { count })}</span>
                {count > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {group.bindings.map((binding) => (
                            <Badge key={binding} variant="secondary">
                                {binding}
                            </Badge>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

/** Fixed card display order: KV → R2 → Vectorize. */
const TAB_ORDER = ["kv", "files", "vectors"];

/** Replace the card for `card.tab` (if already present) and keep the list in {@link TAB_ORDER}. */
const upsertCard = (current: BindingGroup[], card: BindingGroup): BindingGroup[] =>
    [...current.filter((group) => group.tab !== card.tab), card].toSorted((a, b) => TAB_ORDER.indexOf(a.tab) - TAB_ORDER.indexOf(b.tab));

/**
 * The Home **Bindings** overview — a card per configured Cloudflare-binding
 * capability (KV namespaces, R2 buckets, Vectorize indexes) showing its count and
 * the bound names as chips, each linking to its browser tab. Gated on
 * `useStudioFeatures` so only capabilities the app actually wires appear; renders
 * nothing when none are configured (or none have resolved yet). Every read is
 * best-effort — a failing list just omits its card rather than blanking the page.
 */
const BindingsOverview = (): null | ReactElement => {
    const client = useLunora();
    const features = useStudioFeatures();
    const t = useT();

    // One list of resolved cards, built as each best-effort read settles — each
    // card is upserted by its tab and kept in the fixed KV → R2 → Vectorize order.
    const [groups, setGroups] = useState<BindingGroup[]>([]);

    useEffect(() => {
        const token = { cancelled: false };

        const sources = [
            {
                enabled: features.kv,
                label: t("KV Namespaces"),
                load: async (): Promise<string[]> => {
                    const namespaces = await client.listKvNamespaces();

                    return namespaces.map((ns) => ns.binding);
                },
                tab: "kv",
                testId: "home-binding-kv",
            },
            { enabled: features.storage, label: t("R2 Buckets"), load: () => client.listStorageBuckets(), tab: "files", testId: "home-binding-r2" },
            {
                enabled: features.vectors,
                label: t("Vectorize Indexes"),
                load: async (): Promise<string[]> => {
                    const indexes = await client.listVectorIndexes();

                    return indexes.map((index) => index.name);
                },
                tab: "vectors",
                testId: "home-binding-vectors",
            },
        ];

        for (const source of sources) {
            if (!source.enabled) {
                continue;
            }

            fireAndForget(
                (async (): Promise<void> => {
                    try {
                        const bindings = await source.load();

                        if (!token.cancelled) {
                            const card: BindingGroup = { bindings, label: source.label, tab: source.tab, testId: source.testId };

                            setGroups((current) => upsertCard(current, card));
                        }
                    } catch {
                        /* best-effort — omit the card */
                    }
                })(),
            );
        }

        return () => {
            token.cancelled = true;
        };
    }, [client, features.kv, features.storage, features.vectors, t]);

    if (groups.length === 0) {
        return null;
    }

    return (
        <section className="flex flex-col gap-3" data-testid="home-bindings">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("Bindings")}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {groups.map((group) => (
                    <BindingCard group={group} key={group.tab} />
                ))}
            </div>
        </section>
    );
};
export default BindingsOverview;
