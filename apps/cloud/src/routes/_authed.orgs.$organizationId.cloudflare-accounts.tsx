import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { CloudflareAccountsSection } from "../client/CloudflareAccountsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const CloudflareAccountsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <CloudflareAccountsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `cloudflare-accounts` tab — the org's own Cloudflare accounts (`cloudflare-workers`); see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/cloudflare-accounts")({
    component: CloudflareAccountsSectionRoute,
    loader: sectionLoader(api.cloudflare_accounts.list),
});
