import { useMutation, useQuery } from "@lunora/react";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import type { TargetId } from "../provision-contract";
import { isTargetId } from "../provision-contract";
import type { BoxView } from "./boxes";
import { assessTargetDraft, assignableBoxes, BOX_STATUS, canManage } from "./boxes";
import { Field, FormError } from "./section-ui";
import { TARGET_OPTIONS, targetLabel } from "./target-capabilities";
import type { BoxId, OrgId, ProjectId } from "./types";
import { useMyRole } from "./use-boxes";

interface ProjectTargetCardProps {
    /** The box the project is on now, for a `celld-vps` project. */
    boxId?: string;
    organizationId: OrgId;
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
 * Project settings → Deploy target (plan 458 W9): Lunora Cloud's Cloudflare
 * target, or one of the org's own boxes, through `boxes.setProjectTarget`.
 *
 * Owner/admin only, like the mutation. The copy is explicit that a switch moves
 * no data: the server refuses it while the project still has deployments on its
 * current target, so the operator learns that here rather than from the error.
 *
 * The draft starts from the saved target and box; the parent keys this card on
 * both, so a save (or a change made elsewhere) remounts it from the new values.
 */
export const ProjectTargetCard = ({ boxId, organizationId, projectId, target }: ProjectTargetCardProps): ReactElement => {
    const boxes = useQuery(api.boxes.list, { organizationId });
    const manage = canManage(useMyRole(organizationId));
    const setTarget = useMutation(api.boxes.setProjectTarget);
    const saved = { boxId: boxId ?? "", target };

    // Plain strings: Base UI's Select is generic over its value, and a branded id
    // collapses that inference. The brands are reapplied at the mutation boundary.
    // react-doctor-disable-next-line react-doctor/no-derived-useState -- an editable draft seeded from the saved value; the parent remounts this card (key = target|box) whenever the saved value changes
    const [draft, setDraft] = useState(saved);
    const [error, setError] = useState<null | string>(null);

    const { changed, complete, needsBox } = assessTargetDraft(draft, saved);
    const currentBox = boxes?.find((box) => box._id === boxId)?.name ?? "a box";

    const save = (): void => {
        if (!isTargetId(draft.target)) {
            return;
        }

        const next = draft.target;

        setError(null);
        void (async () => {
            try {
                await setTarget.mutate({ ...(next === "celld-vps" ? { boxId: draft.boxId as BoxId } : {}), organizationId, projectId, target: next });
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
                    Now: {target === "celld-vps" ? `${targetLabel(target)} — ${currentBox}` : targetLabel(target)}. Switching the target does not move data: the
                    move is refused while this project still has deployments on its current target, so delete them and wait for teardown first.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid max-w-md gap-4">
                <Field htmlFor="project-target" label="Target">
                    <Select
                        disabled={!manage}
                        onValueChange={(value) => {
                            setDraft((current) => {
                                return { ...current, target: value ?? target };
                            });
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

                {needsBox ? (
                    <BoxPicker
                        boxes={boxes}
                        disabled={!manage}
                        onChange={(value) => {
                            setDraft((current) => {
                                return { ...current, boxId: value };
                            });
                            setError(null);
                        }}
                        organizationId={organizationId}
                        value={draft.boxId}
                    />
                ) : null}

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
