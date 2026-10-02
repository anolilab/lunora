import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { TargetId } from "../provision-contract";
import { TARGETS } from "../provision-contract";
import { COLUMN_LABEL } from "./section-styles";
import { StatusBadge } from "./section-ui";
import { refusedBindings, TARGET_CAPABILITIES_INTRO, TARGET_PROPERTIES, targetLabel } from "./target-capabilities";

/**
 * What a project on its own server or in its own Cloudflare account cannot
 * have, each with the reason (plan 458 W9, `MULTIPLATFORM.md` Phase 3 item 5):
 * the binding types a deploy would refuse, and the target's limitations — the
 * per-plan runtime limits that do not apply, point-in-time recovery, custom
 * domains, runtime logs — rather than tabs that render empty and let the
 * operator guess why.
 *
 * Renders nothing for a target that lacks nothing beyond its bindings
 * (`cloudflare-wfp`, whose refusals the deploy error already words and which the
 * rest of the studio describes as-is).
 */
export const TargetCapabilitiesCard = ({ target }: { target: TargetId }): null | ReactElement => {
    const { limitations } = TARGETS[target];

    if (limitations.length === 0) {
        return null;
    }

    const bindings = refusedBindings(target);
    const properties = TARGET_PROPERTIES[target] ?? [];

    return (
        <Card>
            <CardHeader>
                <CardTitle>Not available on {targetLabel(target).toLowerCase()}</CardTitle>
                <CardDescription>
                    {TARGET_CAPABILITIES_INTRO[target] ?? targetLabel(target)} These are refused or do not apply there; a deploy that needs a refused binding
                    fails before anything is created.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
                <ul className="m-0 grid list-none gap-3 p-0">
                    {limitations.map((limitation) => (
                        <li className="grid gap-1" key={limitation.id}>
                            <span className="flex items-center gap-2 text-sm font-medium">
                                {limitation.label}
                                <StatusBadge>unavailable</StatusBadge>
                            </span>
                            <span className="text-sm text-muted-foreground">{limitation.reason}</span>
                        </li>
                    ))}
                </ul>

                <div className="grid gap-2">
                    <span className={`${COLUMN_LABEL} text-muted-foreground`}>Bindings this target refuses</span>
                    <dl className="m-0 grid gap-2">
                        {bindings.map((binding) => (
                            <div className="grid gap-0.5 sm:grid-cols-[12rem_1fr] sm:gap-3" key={binding.type}>
                                <dt className="text-sm font-medium">{binding.label}</dt>
                                <dd className="m-0 text-sm text-muted-foreground">{binding.reason}</dd>
                            </div>
                        ))}
                    </dl>
                </div>

                {properties.length > 0 ? (
                    <div className="grid gap-2">
                        <span className={`${COLUMN_LABEL} text-muted-foreground`}>Good to know</span>
                        <ul className="m-0 grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
                            {properties.map((property) => (
                                <li key={property}>{property}</li>
                            ))}
                        </ul>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
};
