import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";

interface MembersSectionProps {
    organizationId: OrgId;
    /** SSR-preloaded roster: painted on the first render, then kept live. */
    preloaded: Preloaded<ReturnOf<typeof api.members.list>>;
}

/**
 * Members tab: the org's members (server-rendered, then live) with their roles,
 * plus an add-by-user-id control. New members default to the `member` role
 * server-side; role changes and ownership transfer are governed by
 * `authz.assertMember`.
 */
export const MembersSection = ({ organizationId, preloaded }: MembersSectionProps): ReactElement => {
    const members = usePreloadedQuery(preloaded);
    const addMember = useMutation(api.members.add);
    const removeMember = useMutation(api.members.remove);

    const [userId, setUserId] = useState("");
    const [error, setError] = useState<null | string>(null);

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

            <Card>
                <CardHeader>
                    <CardTitle>Add member</CardTitle>
                </CardHeader>
                <CardContent>
                    <FieldForm
                        action={() => {
                            setError(null);

                            void (async () => {
                                try {
                                    await addMember.mutate({ organizationId, role: "member", userId });
                                    setUserId("");
                                } catch (error_: unknown) {
                                    setError(error_ instanceof Error ? error_.message : "add failed");
                                }
                            })();
                        }}
                    >
                        <Field htmlFor="member-user-id" label="User id">
                            <Input
                                id="member-user-id"
                                onChange={(event) => {
                                    setUserId(event.target.value);
                                }}
                                placeholder="user id"
                                required
                                value={userId}
                            />
                        </Field>
                        <Button className="justify-self-start" disabled={addMember.pending} type="submit">
                            Add member
                        </Button>
                        <FormError message={error} />
                    </FieldForm>
                </CardContent>
            </Card>
        </div>
    );
};
