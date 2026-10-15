import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";

interface MembersSectionProps {
    organizationId: OrgId;
    /** SSR-preloaded roster: painted on the first render, then kept live. */
    preloaded: Preloaded<ReturnOf<typeof api.members.list>>;
}

/**
 * Members tab: the org's members (server-rendered, then live) with their roles.
 * People join through an invitation (`InvitationsSection`), which they accept
 * themselves; role changes and ownership transfer are governed by
 * `authz.assertMember`.
 */
export const MembersSection = ({ organizationId, preloaded }: MembersSectionProps): ReactElement => {
    const members = usePreloadedQuery(preloaded);
    const removeMember = useMutation(api.members.remove);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Members</CardTitle>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No members yet."
                        render={(rows) => (
                            <RowList>
                                {rows.map((member) => (
                                    <Row key={member._id}>
                                        <span className="shrink-0 font-medium">{member.userId}</span>
                                        <StatusBadge>{member.role}</StatusBadge>
                                        <RowActions>
                                            <Button
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => {
                                                    void removeMember.mutate({ id: member._id, organizationId });
                                                }}
                                                size="sm"
                                                variant="ghost"
                                            >
                                                Remove
                                            </Button>
                                        </RowActions>
                                    </Row>
                                ))}
                            </RowList>
                        )}
                        rows={members}
                    />
                </CardContent>
            </Card>
        </div>
    );
};
