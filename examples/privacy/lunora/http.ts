import { httpAction, httpRouter } from "lunorash/server";

import { internal } from "./_generated/internal.js";
import { FILE_ROUTE, fileResponse } from "./privacy-files";

export const app = httpRouter();

/**
 * Serves an export archive to whoever holds its link. The signed link is the credential, so the
 * request needs no session: a subject can open the link from an email or another device. The link
 * is checked before the file is read, and every refusal is the same 404.
 */
app.get(
    FILE_ROUTE,
    httpAction(async (ctx, request) => {
        const url = new URL(request.url);

        return fileResponse({ exp: url.searchParams.get("exp"), key: url.searchParams.get("key"), sig: url.searchParams.get("sig") }, Date.now(), async (key) =>
            ctx.runQuery(internal.requests.exportFile, { key }),
        );
    }),
);
