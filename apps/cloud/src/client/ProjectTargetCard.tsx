import { useMutation, useQuery } from "@lunora/react";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import type { TargetId } from "../provision-contract";
import { isTargetId, TARGETS } from "../provision-contract";
import type { PlacedOn } from "../targets/placement";
import type { BoxView } from "./boxes";
import { assignableBoxes, BOX_STATUS, canManage } from "./boxes";
import type { CloudflareAccountView } from "./cloudflare-accounts";
import { accountTitle } from "./cloudflare-accounts";
import { Field, FormError } from "./section-ui";
import type { TargetDraft } from "./target-capabilities";
import { assessTargetDraft, retargetDraft, TARGET_OPTIONS, targetLabel } from "./target-capabilities";
import type { BoxId, CloudflareAccountId, OrgId, ProjectId } from "./types";
import { useMyRole } from "./use-boxes";

interface ProjectTargetCardProps {
    organizationId: OrgId;
    /** The host the project is placed on now — a box or a connected account, as its target's `placedOn` says. */
    placementRef?: string;
    projectId: ProjectId; // secret-scanner:allow -- domain field name
    target: TargetId;
}

/**
 * The box half of the form: a picker over the org's boxes that are not revoked,
 * or — with none — a pointer to the Boxes tab. Nothing while the list loads.
 */
const BoxPicker = ({
    boxes,
    disabled,
    onChange,
    organizationId,
    value,
}: {
    boxes: ReadonlyArray<BoxView> | undefined;
    disabled: boolean;
    onChange: (value: string) => void;
    organizationId: OrgId;
    value: string;
}): null | ReactElement => {
    if (boxes === undefined) {
        return null;
    }

    const candidates = assignableBoxes(boxes);

    if (candidates.length === 0) {
        return (
            <p className="m-0 text-sm text-muted-foreground">
                This organization has no box to deploy to.{" "}
                <Link className="underline-offset-2 hover:underline" params={{ organizationId }} to="/orgs/$organizationId/boxes">
                    Enrol one on the Boxes tab
                </Link>
                .
            </p>
        );
    }

    return (
        <Field htmlFor="project-box" label="Box">
            <Select
                disabled={disabled}
                onValueChange={(next) => {
                    onChange(next ?? "");
                }}
                value={value}
            >
                <SelectTrigger className="w-full" id="project-box">
                    <SelectValue placeholder="Select a box…" />
                </SelectTrigger>
                <SelectContent>
                    {candidates.map((box) => (
                        <SelectItem key={box._id} value={box._id}>
                            {box.name} ({BOX_STATUS[box.status].label})
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
};

/**
 * The account half of the form: a picker over the org's connected Cloudflare
 * accounts, or — with none — a pointer to the Cloudflare accounts tab.
 */
const AccountPicker = ({
    accounts,
    disabled,
    onChange,
    organizationId,
    value,
}: {
    accounts: ReadonlyArray<CloudflareAccountView> | undefined;
    disabled: boolean;
    onChange: (value: string) => void;
    organizationId: OrgId;
    value: string;
}): null | ReactElement => {
    if (accounts === undefined) {
        return null;
    }

    if (accounts.length === 0) {
        return (
            <p className="m-0 text-sm text-muted-foreground">
                This organization has no Cloudflare account connected.{" "}
                <Link className="underline-offset-2 hover:underline" params={{ organizationId }} to="/orgs/$organizationId/cloudflare-accounts">
                    Connect one on the Cloudflare accounts tab
                </Link>
                .
            </p>
        );
    }

    return (
        <Field htmlFor="project-cloudflare-account" label="Cloudflare account">
            <Select
                disabled={disabled}
                onValueChange={(next) => {
                    onChange(next ?? "");
                }}
                value={value}
            >
                <SelectTrigger className="w-full" id="project-cloudflare-account">
                    <SelectValue placeholder="Select an account…" />
                </SelectTrigger>
                <SelectContent>
                    {accounts.map((account) => (
                        <SelectItem key={account._id} value={account._id}>
                            {accountTitle(account)} — {account.workersSubdomain}.workers.dev
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
};

/**
 * Project settings → Deploy target (plan 458 W9, MULTIPLATFORM.md Phase 3):
 * Lunora Cloud's Cloudflare target, one of the org's own boxes, or one of its
 * connected Cloudflare accounts, through `projects.setTarget`.
 *
 * Owner/admin only, like the mutation. The copy is explicit that a switch moves
 * no data: the server refuses it while the project still has deployments on its
 * current target, so the operator learns that here rather than from the error.
 *
 * Which host the form asks for follows the drafted target's `placedOn` — one
 * picker per kind of host, chosen by it. The draft starts from the saved
 * target and host; the parent keys this card on both, so a save (or a change
 * made elsewhere) remounts it from the new values.
 */
export const ProjectTargetCard = ({ organizationId, placementRef, projectId, target }: ProjectTargetCardProps): ReactElement => {
    const boxes = useQuery(api.boxes.list, { organizationId });
    const accounts = useQuery(api.cloudflare_accounts.list, { organizationId });
    const manage = canManage(useMyRole(organizationId));
    const setTarget = useMutation(api.projects.setTarget);
    const saved: TargetDraft = { placementRef: placementRef ?? "", target };

    // Plain strings: Base UI's Select is generic over its value, and a branded id
    // collapses that inference. The brand is reapplied at the mutation boundary.
    // react-doctor-disable-next-line react-doctor/no-derived-useState -- an editable draft seeded from the saved value; the parent remounts this card (key = target|host) whenever the saved value changes
    const [draft, setDraft] = useState(saved);
    const [error, setError] = useState<null | string>(null);

    const { changed, complete, placedOn } = assessTargetDraft(draft, saved);
    const savedPlacedOn = TARGETS[target].placedOn;
    const currentAccount = accounts?.find((account) => account._id === placementRef);
    const currentHost: Record<PlacedOn, string | undefined> = {
        account: currentAccount === undefined ? "an account" : accountTitle(currentAccount),
        box: boxes?.find((box) => box._id === placementRef)?.name ?? "a box",
        cell: undefined,
    };
    const hostNow = currentHost[savedPlacedOn];
    const now = hostNow === undefined ? targetLabel(target) : `${targetLabel(target)} — ${hostNow}`;

    const pick = (value: string): void => {
        setDraft((current) => {
            return { ...current, placementRef: value };
        });
        setError(null);
    };
    const pickers: Record<PlacedOn, null | ReactElement> = {
        account: <AccountPicker accounts={accounts} disabled={!manage} onChange={pick} organizationId={organizationId} value={draft.placementRef} />,
        box: <BoxPicker boxes={boxes} disabled={!manage} onChange={pick} organizationId={organizationId} value={draft.placementRef} />,
        cell: null,
    };

    const save = (): void => {
        if (!isTargetId(draft.target)) {
            return;
        }

        const next = draft.target;

        setError(null);
        void (async () => {
            try {
                await setTarget.mutate({
                    organizationId,
                    // The picker offered only rows of the table this target's `placedOn` names.
                    ...(TARGETS[next].placedOn === "cell" ? {} : { placementRef: draft.placementRef as BoxId | CloudflareAccountId }),
                    projectId,
                    target: next,
                });
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "could not change the deploy target");
            }
        })();
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Deploy target</CardTitle>
                <CardDescription>
                    Now: {now}. Switching the target does not move data: the move is refused while this project still has deployments on its current target, so
                    delete them and wait for teardown first.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid max-w-md gap-4">
                <Field htmlFor="project-target" label="Target">
                    <Select
                        disabled={!manage}
                        onValueChange={(value) => {
                            setDraft((current) => retargetDraft(current, value ?? target, saved));
                            setError(null);
                        }}
                        value={draft.target}
                    >
                        <SelectTrigger className="w-full" id="project-target">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TARGET_OPTIONS.map((option) => (
                                <SelectItem key={option.id} value={option.id}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <p className="m-0 text-xs text-muted-foreground">{TARGET_OPTIONS.find((option) => option.id === draft.target)?.description}</p>

                {placedOn === undefined ? null : pickers[placedOn]}

                {manage ? (
                    <Button className="justify-self-start" disabled={!changed || !complete || setTarget.pending} onClick={save} type="button">
                        {setTarget.pending ? "Saving…" : "Save target"}
                    </Button>
                ) : (
                    <p className="m-0 text-sm text-muted-foreground">Only owners and admins can change the deploy target.</p>
                )}
                <FormError message={error} />
            </CardContent>
        </Card>
    );
};
