/**
 * The runnable example apps, transcribed from `examples/README.md`.
 *
 * That table is the source of truth and this file must not drift from it. In
 * particular `deploy` is only set for the five rows that actually carry a deploy
 * button: a button pointing at an example Cloudflare cannot provision lands the
 * reader on a broken build, which is strictly worse than a source link.
 */

/**
 * What the example's frontend is, from its dependencies: `@tanstack/react-start`
 * for SSR, `expo` for the mobile client, and a Vite + react-dom pair for the
 * plain SPA the other eleven use.
 */
type Platform = "native" | "spa" | "ssr";

type Capability = "ai" | "auth" | "auth-ui" | "bindings" | "d1" | "notify" | "payment" | "ratelimit" | "react-native" | "scheduler" | "storage";

interface Example {
    /**
     * Present only when the README's Deploy column has a button. `open` means the
     * example deliberately ships no auth, so a deployed instance is readable and
     * writable by anyone holding the URL — the card has to say so.
     */
    deploy?: "auth" | "open";
    /** Directory under `examples/`, and the `@lunora-example/<dir>` package name. */
    dir: string;
    /** See {@link Platform}. */
    platform: Platform;
    /** The README's "Shows off" column. */
    shows: string;

    /**
     * The opt-in `@lunora/*` packages the example depends on, from its own
     * package.json — the base (react, vite, lunorash, errors) is in all thirteen
     * and says nothing, so it is left out. This is what the filters count, so it
     * has to track the example's dependencies rather than its prose.
     */
    uses: Capability[];
    /** The README's "What it is" column. */
    what: string;
}

const examples: Example[] = [
    {
        deploy: "open",
        dir: "kanban-board",
        platform: "spa",
        uses: ["ratelimit"],
        shows: "Fractional index ordering, server-resolved drops, multi-query optimistic updates",
        what: "Drag-and-drop board, live for everyone looking at it",
    },
    {
        deploy: "open",
        dir: "feedback-board",
        platform: "spa",
        uses: ["ai", "ratelimit"],
        shows: "Unique index as a constraint, denormalised counters, ctx.ai from an action",
        what: "Public feature-request board with AI summaries",
    },
    {
        deploy: "auth",
        dir: "team-chat",
        platform: "spa",
        uses: ["auth", "d1", "ratelimit", "storage"],
        shows: "A shard per channel, all three data tiers, authorizeShard, signed R2 uploads",
        what: "Channels, presence, search, file uploads",
    },
    {
        deploy: "auth",
        dir: "chess",
        platform: "spa",
        uses: ["auth", "d1", "ratelimit"],
        shows: "Server-authoritative rules, serialized mutations as a game rule, in-transaction settlement",
        what: "Multiplayer chess with lobbies, spectators and Elo",
    },
    {
        deploy: "open",
        dir: "tanstack-start",
        platform: "ssr",
        uses: ["ratelimit"],
        shows: "Route loaders sharing a cache key with useQuery, one worker for SSR + RPC",
        what: "SSR that hands over to a live socket",
    },
    {
        dir: "todo-app",
        platform: "spa",
        uses: [],
        shows: "defineSchema, one query + one mutation, optimistic updates",
        what: "The smallest CRUD round-trip",
    },
    {
        dir: "blog",
        platform: "spa",
        uses: ["auth", "bindings", "d1", "scheduler", "storage"],
        shows: ".global() tables, .vectorize(), R2 images, a nightly cron",
        what: "Posts, drafts, semantic search",
    },
    {
        dir: "realtime-cursors",
        platform: "spa",
        uses: [],
        shows: ".shardBy() and per-room WebSocket fan-out",
        what: "Shared cursors, one shard per room",
    },
    {
        dir: "auth-playground",
        platform: "spa",
        uses: ["auth", "auth-ui"],
        shows: "@lunora/auth with the better-auth plugin surface",
        what: "Sign-in, organizations, admin, 2FA",
    },
    {
        dir: "payment-demo",
        platform: "spa",
        uses: ["payment"],
        shows: "@lunora/payment, webhook sync, entitlements",
        what: "Checkout and subscription state",
    },
    {
        dir: "notify-demo",
        platform: "spa",
        uses: ["notify"],
        shows: "@lunora/notify, subscription stores, queue fan-out",
        what: "Web Push notifications",
    },
    {
        dir: "offline-rejections",
        platform: "spa",
        uses: [],
        shows: "Durable offline outbox, rejection replay",
        what: "What an offline queue does when the server says no",
    },
    {
        dir: "expo",
        platform: "native",
        uses: ["auth", "react-native"],
        shows: "@lunora/react-native, the Expo auth bridge",
        what: "React Native client",
    },
];

const sourceUrl = (directory: string): string => `https://github.com/anolilab/lunora/tree/alpha/examples/${directory}`;

const deployUrl = (directory: string): string => `https://deploy.workers.cloudflare.com/?url=${sourceUrl(directory)}`;

export { deployUrl, examples, sourceUrl };
export type { Example };
