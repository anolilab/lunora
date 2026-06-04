import { loader } from "fumadocs-core/source";

import { docs } from "@/.source/server";

/**
 * Fumadocs loader that turns the generated `.source` map into the page-tree
 * the docs UI consumes. The `baseUrl` here must match the route segment
 * mounted at `app/docs/[[...slug]]/page.tsx`. The `docs` export lives in the
 * `.source/server.ts` file emitted by `fumadocs-mdx` (the `.d.ts` stub
 * checked into the repo only ever advertises the same `docs` symbol).
 */
// eslint-disable-next-line import/prefer-default-export -- shared named binding imported by multiple route/layout modules
export const source = loader({
    baseUrl: "/docs",
    source: docs.toFumadocsSource(),
});
