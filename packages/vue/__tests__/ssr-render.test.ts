import type { FunctionReference, Preloaded } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";

import { hydratePreloaded } from "../src/hydrate-preloaded";
import { createLunora } from "../src/lunora-provider";
import { useQuery } from "../src/use-query";
import { createFakeClient } from "./fake-client";

interface Post {
    id: number;
    title: string;
}

const listPosts: FunctionReference = { __lunoraRef: "posts:list" };

const preloaded: Preloaded<Post[]> = {
    __lunoraPreloaded: true,
    args: { room: "general" },
    functionPath: "posts:list",
    value: [{ id: 1, title: "seeded" }],
};

/** The documented Nuxt page: a preloaded seed plus a live query, rendered on the server. */
const Page = defineComponent({
    setup() {
        const posts = hydratePreloaded<Post[]>(preloaded);
        const live = useQuery(listPosts, {});

        return () => h("p", `${JSON.stringify(posts.value)}|${live.value === undefined ? "EMPTY" : "LIVE"}`);
    },
});

describe("server render", () => {
    // Every composable resolves its client through `useLunora()`, which throws
    // when nothing is injected — and that call is unconditional, ahead of the
    // `isBrowser()` guard. So the provider must be universal: `@lunora/nuxt`'s
    // template ships `plugins/lunora.ts`, NOT `plugins/lunora.client.ts`, which
    // never runs on the server and left the first SSR'd page 500ing.
    it("throws when no plugin provided a client on the server", async () => {
        expect.assertions(1);

        await expect(renderToString(createSSRApp(Page))).rejects.toThrow("useLunora(): no LunoraClient provided");
    });

    // The other half: providing the client server-side is safe. Both composables
    // gate their subscription on a browser `window` (absent under `node`), so the
    // render emits the preloaded seed and an empty live value while opening
    // nothing. The socket attaches on hydration.
    it("renders the preloaded seed and opens no subscription when a client is provided", async () => {
        expect.assertions(2);

        const fake = createFakeClient();
        const app = createSSRApp(Page);

        app.use(createLunora(fake.client));

        const html = await renderToString(app);

        expect(html).toBe("<p>[{&quot;id&quot;:1,&quot;title&quot;:&quot;seeded&quot;}]|EMPTY</p>");
        expect(fake.subscribeCalls).toHaveLength(0);
    });
});
