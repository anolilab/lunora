import { Add01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
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
import type { BoxView, MemberRole } from "./boxes";
import { canDiagnose, canManage } from "./boxes";
import { BoxListItem } from "./BoxListItem";
import { DiagnoseBoxDialog } from "./DiagnoseBoxDialog";
import { EnrolBoxDialog } from "./EnrolBoxDialog";
import { RenameBoxDialog } from "./RenameBoxDialog";
import { RevokeBoxDialog } from "./RevokeBoxDialog";
import type { SectionProps } from "./tabs";
import { projectNamesByHost } from "./target-capabilities";
import { useBoxDomain, useMyRole } from "./use-boxes";

/** Stable empty list for a box with no projects (a fresh `[]` per row trips react-perf). */
const NO_PROJECTS: ReadonlyArray<string> = [];

interface BoxListProps {
    boxes: ReadonlyArray<BoxView>;
    domain?: string;
    onDiagnose: (box: BoxView) => void;
    onRename: (box: BoxView) => void;
    onRevoke: (box: BoxView) => void;
    projectsByBox: ReadonlyMap<string, string[]>;
    role: MemberRole | undefined;
}

/** The boxes, each with the actions the caller's role allows on it. */
const BoxList = ({ boxes, domain, onDiagnose, onRename, onRevoke, projectsByBox, role }: BoxListProps): ReactElement => (
    <ul className="m-0 grid list-none p-0">
        {boxes.map((box) => (
            <BoxListItem
                box={box}
                diagnose={canDiagnose(role, box)}
                domain={domain}
                key={box._id}
                manage={canManage(role)}
                onDiagnose={() => {
                    onDiagnose(box);
                }}
                onRename={() => {
                    onRename(box);
                }}
                onRevoke={() => {
                    onRevoke(box);
                }}
                projects={projectsByBox.get(box._id) ?? NO_PROJECTS}
            />
        ))}
    </ul>
);

/**
 * Boxes tab (plan 458 W9): the organization's own servers that `celld-vps`
 * projects deploy to. Lists every box — revoked ones too, for their history —
 * and lets an owner or admin enrol, rename, diagnose (a connected box) and
 * revoke. Members see the same list without the controls; the mutations and
 * routes assert the role regardless.
 */
export const BoxesSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.boxes.list>>): ReactElement => {
    const boxes = usePreloadedQuery(preloaded);
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const role = useMyRole(organizationId);
    const manage = canManage(role);
    const domain = useBoxDomain(organizationId);

    // `seq` remounts the enrol dialog per open, so a token minted earlier never reappears.
    const [enrolDialog, setEnrolDialog] = useState({ open: false, seq: 0 });
    const [renaming, setRenaming] = useState<BoxView | null>(null);
    const [revoking, setRevoking] = useState<BoxView | null>(null);
    const [diagnosing, setDiagnosing] = useState<BoxView | null>(null);
    const [notice, setNotice] = useState<null | string>(null);

    const projectsByBox = projectNamesByHost(projects);

    const openEnrol = (): void => {
        setEnrolDialog((current) => {
            return { open: true, seq: current.seq + 1 };
        });
    };

    const enrolButton = manage ? (
        <Button onClick={openEnrol} size="sm" type="button">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            Enrol a box
        </Button>
    ) : null;

    let body: ReactElement;

    if (boxes === undefined) {
        body = (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
            </div>
        );
    } else if (boxes.length === 0) {
        body = (
            <Empty className="border-0 py-10">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
                    </EmptyMedia>
                    <EmptyTitle>Run your apps on your own server</EmptyTitle>
                    <EmptyDescription>
                        A box is a Linux server your organization owns. Lunora Cloud deploys your apps onto it with celld and manages it through an agent that
                        dials out to us, so the control plane never needs a way in. Your apps&apos; data stays in your own bucket.
                    </EmptyDescription>
                </EmptyHeader>
                <div className="flex justify-center">
                    {enrolButton ?? <p className="m-0 text-sm text-muted-foreground">Ask an owner or admin to enrol one.</p>}
                </div>
            </Empty>
        );
    } else {
        body = (
            <BoxList
                boxes={boxes}
                domain={domain}
                onDiagnose={setDiagnosing}
                onRename={setRenaming}
                onRevoke={(box) => {
                    setNotice(null);
                    setRevoking(box);
                }}
                projectsByBox={projectsByBox}
                role={role}
            />
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Boxes</CardTitle>
                    <CardDescription>
                        Servers you run that projects can deploy to. Point a project at one from its settings, under Deploy target.
                        {manage ? null : " Only owners and admins can enrol, rename or revoke boxes."}
                    </CardDescription>
                    {boxes !== undefined && boxes.length > 0 && enrolButton ? <CardAction>{enrolButton}</CardAction> : null}
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    {notice ? (
                        <p className="m-0 text-sm text-warning" role="status">
                            {notice}
                        </p>
                    ) : null}
                    {body}
                </CardContent>
            </Card>

            <EnrolBoxDialog
                key={enrolDialog.seq}
                onOpenChange={(open) => {
                    setEnrolDialog((current) => {
                        return { ...current, open };
                    });
                }}
                open={enrolDialog.open}
                organizationId={organizationId}
            />
            {renaming ? (
                <RenameBoxDialog
                    box={renaming}
                    onClose={() => {
                        setRenaming(null);
                    }}
                    organizationId={organizationId}
                />
            ) : null}
            <DiagnoseBoxDialog
                box={diagnosing}
                key={diagnosing?._id ?? "none"}
                onClose={() => {
                    setDiagnosing(null);
                }}
                organizationId={organizationId}
            />
            <RevokeBoxDialog
                box={revoking}
                onClose={() => {
                    setRevoking(null);
                }}
                onNotice={setNotice}
                organizationId={organizationId}
            />
        </div>
    );
};
