import { Add01Icon, CloudIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../lunora/_generated/api.js";
import { canManage } from "./boxes";
import type { CloudflareAccountView } from "./cloudflare-accounts";
import { accountTitle, missingPermissions, permissionLabel } from "./cloudflare-accounts";
import { ConnectCloudflareAccountDialog } from "./ConnectCloudflareAccountDialog";
import { DisconnectCloudflareAccountDialog } from "./DisconnectCloudflareAccountDialog";
import { COLUMN_LABEL } from "./section-styles";
import { RelativeTime, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import { useMyRole } from "./use-boxes";

/** Stable empty list for an account no project uses (a fresh `[]` per row trips react-perf). */
const NO_PROJECTS: ReadonlyArray<string> = [];

/** The connect dialog's state: closed, connecting a new account, or rotating one connection's token. */
type ConnectDialog = { mode: "closed" } | { mode: "connect" } | { account: CloudflareAccountView; mode: "rotate" };

const AccountItem = ({
    account,
    manage,
    onDisconnect,
    onRotate,
    projects,
}: {
    account: CloudflareAccountView;
    manage: boolean;
    onDisconnect: () => void;
    onRotate: () => void;
    projects: ReadonlyArray<string>;
}): ReactElement => {
    const missing = missingPermissions(account.permissions);

    return (
        <li className="grid gap-2 border-b py-4 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{accountTitle(account)}</span>
                <span className="font-mono text-xs text-muted-foreground">{account.accountId}</span>
                {manage ? (
                    <span className="ml-auto flex items-center gap-1">
                        <Button onClick={onRotate} size="sm" type="button" variant="ghost">
                            Rotate token
                        </Button>
                        <Button className="text-destructive hover:text-destructive" onClick={onDisconnect} size="sm" type="button" variant="ghost">
                            Disconnect
                        </Button>
                    </span>
                ) : null}
            </div>
            <dl className="m-0 grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className={`${COLUMN_LABEL} text-muted-foreground`}>Workers on</dt>
                <dd className="m-0 font-mono text-xs">{`*.${account.workersSubdomain}.workers.dev`}</dd>
                <dt className={`${COLUMN_LABEL} text-muted-foreground`}>Token verified</dt>
                <dd className="m-0">
                    <RelativeTime at={account.verifiedAt} />
                    {account.tokenExpiresAt === undefined ? null : (
                        <span className="text-muted-foreground">
                            {" "}
                            · expires <RelativeTime at={account.tokenExpiresAt} />
                        </span>
                    )}
                </dd>
                <dt className={`${COLUMN_LABEL} text-muted-foreground`}>Permissions</dt>
                <dd className="m-0 flex flex-wrap gap-1">
                    {account.permissions.map((permission) => (
                        <StatusBadge key={permission} tone="success">
                            {permissionLabel(permission)}
                        </StatusBadge>
                    ))}
                </dd>
                {missing.length > 0 ? (
                    <>
                        <dt className={`${COLUMN_LABEL} text-muted-foreground`}>Not granted</dt>
                        <dd className="m-0 text-muted-foreground">
                            {missing.join(", ")} — an app that needs one fails its deploy until the token is rotated with it.
                        </dd>
                    </>
                ) : null}
                <dt className={`${COLUMN_LABEL} text-muted-foreground`}>Projects</dt>
                <dd className="m-0">{projects.length > 0 ? projects.join(", ") : <span className="text-muted-foreground">none yet</span>}</dd>
            </dl>
        </li>
    );
};

/**
 * Cloudflare accounts tab (MULTIPLATFORM.md Phase 3): the organization's own
 * Cloudflare accounts that `cloudflare-workers` projects deploy into, as plain
 * Workers. An owner or admin connects one by pasting a scoped API token, which
 * the edge checks against the account and encrypts before storing; the tab
 * shows what the check found (the account, its workers.dev subdomain, the
 * permission groups the token holds), and lets the token be rotated or the
 * account disconnected. Members see the list without the controls; every
 * mutation asserts the role regardless.
 */
export const CloudflareAccountsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.cloudflare_accounts.list>>): ReactElement => {
    const accounts = usePreloadedQuery(preloaded);
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const manage = canManage(useMyRole(organizationId));
    const [dialog, setDialog] = useState<ConnectDialog>({ mode: "closed" });
    const [disconnecting, setDisconnecting] = useState<CloudflareAccountView | null>(null);

    const projectsByAccount = new Map<string, string[]>();

    for (const project of projects ?? []) {
        if (project.cloudflareAccountId !== undefined) {
            projectsByAccount.set(project.cloudflareAccountId, [...(projectsByAccount.get(project.cloudflareAccountId) ?? []), project.name]);
        }
    }

    const connectButton = manage ? (
        <Button
            onClick={() => {
                setDialog({ mode: "connect" });
            }}
            size="sm"
            type="button"
        >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            Connect an account
        </Button>
    ) : null;

    let body: ReactElement;

    if (accounts === undefined) {
        body = <Skeleton className="h-24 w-full" />;
    } else if (accounts.length === 0) {
        body = (
            <Empty className="border-0 py-10">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <HugeiconsIcon icon={CloudIcon} strokeWidth={2} />
                    </EmptyMedia>
                    <EmptyTitle>Deploy into your own Cloudflare account</EmptyTitle>
                    <EmptyDescription>
                        Connect a Cloudflare account and your projects deploy into it as plain Workers, with their databases, buckets and queues created there.
                        Your data stays in your account, and Cloudflare bills you for it directly.
                    </EmptyDescription>
                </EmptyHeader>
                <div className="flex justify-center">
                    {connectButton ?? <p className="m-0 text-sm text-muted-foreground">Ask an owner or admin to connect one.</p>}
                </div>
            </Empty>
        );
    } else {
        body = (
            <ul className="m-0 grid list-none p-0">
                {accounts.map((account) => (
                    <AccountItem
                        account={account}
                        key={account._id}
                        manage={manage}
                        onDisconnect={() => {
                            setDisconnecting(account);
                        }}
                        onRotate={() => {
                            setDialog({ account, mode: "rotate" });
                        }}
                        projects={projectsByAccount.get(account._id) ?? NO_PROJECTS}
                    />
                ))}
            </ul>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Cloudflare accounts</CardTitle>
                    <CardDescription>
                        Your own Cloudflare accounts that projects can deploy into. Point a project at one from its settings, under Deploy target.
                        {manage ? null : " Only owners and admins can connect, rotate or disconnect accounts."}
                    </CardDescription>
                    {accounts !== undefined && accounts.length > 0 && connectButton ? <CardAction>{connectButton}</CardAction> : null}
                </CardHeader>
                <CardContent>{body}</CardContent>
            </Card>

            {dialog.mode === "closed" ? null : (
                <ConnectCloudflareAccountDialog
                    onClose={() => {
                        setDialog({ mode: "closed" });
                    }}
                    organizationId={organizationId}
                    rotating={dialog.mode === "rotate" ? dialog.account : undefined}
                />
            )}
            <DisconnectCloudflareAccountDialog
                account={disconnecting}
                onClose={() => {
                    setDisconnecting(null);
                }}
                organizationId={organizationId}
            />
        </div>
    );
};
