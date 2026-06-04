import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

// Next.js route handlers must export named HTTP-method functions (`GET`); a
// default export would not be picked up by the App Router.
// eslint-disable-next-line import/prefer-default-export -- Next.js route handler contract
export const { GET } = createFromSource(source);
