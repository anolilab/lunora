import { ExternalLink } from "lucide-react";
import type { FC } from "react";

import { Action } from "@/kit/action";
import { Kicker, Shell } from "@/kit/layout";

/**
 * The runnable examples, straight from `examples/README.md`.
 *
 * Only the five the README gives a deploy button are listed. The other eight
 * exist and are worth reading, but the repo has not wired them for one-click
 * deploy — offering a button that lands on a broken provision is worse than
 * linking the source, so those live behind the "all thirteen" link below.
 *
 * `open: true` is the README's own warning, repeated because it matters more
 * here than there: these three deliberately ship no auth, so a deployed
 * instance is usable by anyone who has the URL. Someone clicking Deploy on a
 * marketing page has not read the README.
 */
const examples: { blurb: string; name: string; open?: boolean; shows: string; slug: string }[] = [
    {
        blurb: "Drag-and-drop board, live for everyone looking at it.",
        name: "Kanban board",
        open: true,
        shows: "Fractional index ordering, server-resolved drops, multi-query optimistic updates",
        slug: "kanban-board",
    },
    {
        blurb: "Channels, presence, search, and file uploads.",
        name: "Team chat",
        shows: "A shard per channel, all three data tiers, authorizeShard, signed R2 uploads",
        slug: "team-chat",
    },
    {
        blurb: "Multiplayer chess with lobbies, spectators and Elo.",
        name: "Chess",
        shows: "Server-authoritative rules, serialized mutations as a game rule, in-transaction settlement",
        slug: "chess",
    },
    {
        blurb: "Public feature-request board with AI summaries.",
        name: "Feedback board",
        open: true,
        shows: "Unique index as a constraint, denormalised counters, ctx.ai from an action",
        slug: "feedback-board",
    },
    {
        blurb: "SSR that hands over to a live socket.",
        name: "TanStack Start",
        open: true,
        shows: "Route loaders sharing a cache key with useQuery, one worker for SSR and RPC",
        slug: "tanstack-start",
    },
];

const REPO_TREE = "https://github.com/anolilab/lunora/tree/alpha/examples";

/** The deploy flow clones the repo, provisions what `wrangler.jsonc` declares, and ships it. */
const deployUrl = (slug: string): string => `https://deploy.workers.cloudflare.com/?url=${REPO_TREE}/${slug}`;

const Examples: FC = () => (
    <Shell className="pt-14">
        <div className="mb-10 flex flex-col gap-3">
            <Kicker size="micro">Examples</Kicker>
            <h3 className="text-h3 font-semibold tracking-tight text-ink">Or start from a working app</h3>
            <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
                Each one is a whole app built around a different part of the framework. Deploy runs it on your own Cloudflare account — it clones the repo,
                provisions the bindings its <code className="font-mono text-ink-muted">wrangler.jsonc</code> declares, and asks for any secret it needs.
            </p>
        </div>

        <div className="grid grid-cols-1 gap-px bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            {examples.map((example) => (
                <div className="flex flex-col gap-3 bg-canvas p-6" key={example.slug}>
                    <h4 className="text-base font-medium tracking-tight text-ink">{example.name}</h4>
                    <p className="text-sm leading-relaxed text-ink-muted">{example.blurb}</p>
                    <p className="text-xs leading-relaxed text-ink-faint">{example.shows}</p>

                    {example.open ? (
                        <p className="font-mono text-micro text-ink-faint uppercase">No sign-in — anyone with the URL can use it</p>
                    ) : (
                        <p className="font-mono text-micro text-ink-faint uppercase">Requires sign-in</p>
                    )}

                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                        <Action href={deployUrl(example.slug)} variant="primary">
                            Deploy
                        </Action>
                        <Action href={`${REPO_TREE}/${example.slug}`} variant="ghost">
                            Source
                            <ExternalLink className="size-3.5" />
                        </Action>
                    </div>
                </div>
            ))}

            <div className="flex flex-col justify-between gap-3 bg-canvas p-6">
                <div className="flex flex-col gap-3">
                    <h4 className="text-base font-medium tracking-tight text-ink">Eight more</h4>
                    <p className="text-sm leading-relaxed text-ink-muted">
                        Auth, payments, push notifications, an offline outbox, semantic search, shared cursors, Expo, and the smallest possible CRUD round-trip.
                    </p>
                </div>
                <Action className="mt-auto" href={REPO_TREE} variant="ghost">
                    All examples
                    <ExternalLink className="size-3.5" />
                </Action>
            </div>
        </div>
    </Shell>
);

export default Examples;
