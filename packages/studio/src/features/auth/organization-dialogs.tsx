import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ModalShell } from "../../components/ui/modal-shell";
import { Textarea } from "../../components/ui/textarea";
import { useAsyncSubmit } from "../../hooks/use-async-submit";
import { useT } from "../../i18n/i18n-context";
import { formatCell } from "../../lib/internal";
import type { Row } from "./types";

/** Parse a textarea into a plain JSON object, rejecting arrays / primitives with a friendly message. */
const parseJsonObject = (text: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Expected a JSON object");
    }

    return parsed as Record<string, unknown>;
};

/** Parse + validate a permission grant (`Record&lt;resource, actions[]>`) from a textarea. */
const parsePermission = (text: string): Record<string, string[]> => {
    const object = parseJsonObject(text);
    const grant: Record<string, string[]> = {};

    for (const [resource, actions] of Object.entries(object)) {
        if (!Array.isArray(actions) || actions.some((action) => typeof action !== "string")) {
            throw new TypeError(`"${resource}" must map to an array of action strings`);
        }

        grant[resource] = actions as string[];
    }

    return grant;
};

/** The metadata / permission value of a row, pretty-printed for a prefilled textarea (empty string when absent). */
const jsonInitial = (value: unknown): string => {
    if (value === undefined || value === null || value === "") {
        return "";
    }

    if (typeof value === "string") {
        return value;
    }

    return JSON.stringify(value, null, 2);
};

/** One labelled `&lt;input>` row. */
const Field = ({ children, htmlFor, label }: { children: ReactNode; htmlFor: string; label: string }): ReactElement => (
    <div className="flex flex-col gap-1">
        <Label htmlFor={htmlFor}>{label}</Label>
        {children}
    </div>
);

/** The shared modal chrome: title, body, error, and a cancel / submit footer. */
const DialogForm = ({
    busy,
    canSubmit,
    children,
    destructive = false,
    error,
    onClose,
    onSubmit,
    submitLabel,
    testId,
    title,
}: {
    readonly busy: boolean;
    readonly canSubmit: boolean;
    readonly children: ReactNode;
    readonly destructive?: boolean;
    readonly error: null | string;
    readonly onClose: () => void;
    readonly onSubmit: () => void;
    readonly submitLabel: string;
    readonly testId: string;
    readonly title: string;
}): ReactElement => {
    const t = useT();

    return (
        <ModalShell label={title} onClose={onClose} panelTestId={`${testId}-panel`} testId={`${testId}-overlay`} variant="dialog">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>

            {children}

            {error !== null && (
                <p className="text-sm text-destructive" data-testid={`${testId}-error`} role="alert">
                    {error}
                </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
                <Button data-testid={`${testId}-cancel`} onClick={onClose} size="sm" type="button" variant="outline">
                    {t("Cancel")}
                </Button>
                <Button
                    data-testid={`${testId}-submit`}
                    disabled={busy || !canSubmit}
                    onClick={onSubmit}
                    size="sm"
                    type="button"
                    variant={destructive ? "destructive" : "default"}
                >
                    {busy ? t("Saving…") : submitLabel}
                </Button>
            </div>
        </ModalShell>
    );
};

/** Create or edit an organization (name / slug / logo / metadata; `ownerId` seeds the owner member on create). */
const OrgFormDialog = ({ mode, onClose, onDone, org }: { mode: "create" | "edit"; onClose: () => void; onDone: () => void; org?: Row }): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const [name, setName] = useState<string>(org ? formatCell(org["name"]) : "");
    const [slug, setSlug] = useState<string>(org ? formatCell(org["slug"]) : "");
    const [logo, setLogo] = useState<string>(org ? formatCell(org["logo"]) : "");
    const [ownerId, setOwnerId] = useState<string>("");
    const [metadata, setMetadata] = useState<string>(mode === "edit" ? jsonInitial(org?.["metadata"]) : "");

    const onSubmit = (): void => {
        run(async () => {
            const parsedMetadata = metadata.trim() === "" ? undefined : parseJsonObject(metadata);

            if (mode === "create") {
                await client.createAuthOrganization({
                    logo: logo.trim() === "" ? undefined : logo.trim(),
                    metadata: parsedMetadata,
                    name: name.trim(),
                    ownerId: ownerId.trim() === "" ? undefined : ownerId.trim(),
                    slug: slug.trim() === "" ? undefined : slug.trim(),
                });
            } else {
                await client.updateAuthOrganization({
                    logo: logo.trim() === "" ? undefined : logo.trim(),
                    metadata: parsedMetadata,
                    name: name.trim() === "" ? undefined : name.trim(),
                    organizationId: formatCell(org?.["id"]),
                    slug: slug.trim() === "" ? undefined : slug.trim(),
                });
            }

            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={name.trim() !== "" || mode === "edit"}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={mode === "create" ? t("Create") : t("Save")}
            testId="org-form"
            title={mode === "create" ? t("New organization") : t("Edit organization")}
        >
            <Field htmlFor="org-form-name" label={t("name")}>
                <Input
                    data-testid="org-form-name"
                    id="org-form-name"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setName(event.target.value);
                    }}
                    value={name}
                />
            </Field>
            <Field htmlFor="org-form-slug" label={t("Slug (optional — derived from name)")}>
                <Input
                    data-testid="org-form-slug"
                    id="org-form-slug"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setSlug(event.target.value);
                    }}
                    value={slug}
                />
            </Field>
            <Field htmlFor="org-form-logo" label={t("Logo URL (optional)")}>
                <Input
                    data-testid="org-form-logo"
                    id="org-form-logo"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setLogo(event.target.value);
                    }}
                    value={logo}
                />
            </Field>
            {mode === "create" && (
                <Field htmlFor="org-form-owner" label={t("Owner user id (optional)")}>
                    <Input
                        data-testid="org-form-owner"
                        id="org-form-owner"
                        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                            setOwnerId(event.target.value);
                        }}
                        value={ownerId}
                    />
                </Field>
            )}
            <Field htmlFor="org-form-metadata" label={t("Metadata (JSON, optional)")}>
                <Textarea
                    data-testid="org-form-metadata"
                    id="org-form-metadata"
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
                        setMetadata(event.target.value);
                    }}
                    value={metadata}
                />
            </Field>
        </DialogForm>
    );
};

/** Directly add an existing user (by id) to an organization. */
const MemberAddDialog = ({ onClose, onDone, organizationId }: { onClose: () => void; onDone: () => void; organizationId: string }): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const [userId, setUserId] = useState<string>("");
    const [role, setRole] = useState<string>("");

    const onSubmit = (): void => {
        run(async () => {
            await client.addAuthOrgMember({ organizationId, role: role.trim() === "" ? undefined : role.trim(), userId: userId.trim() });
            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={userId.trim() !== ""}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={t("Add member")}
            testId="org-add-member"
            title={t("Add member")}
        >
            <Field htmlFor="org-add-member-user" label={t("User id")}>
                <Input
                    data-testid="org-add-member-user"
                    id="org-add-member-user"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setUserId(event.target.value);
                    }}
                    value={userId}
                />
            </Field>
            <Field htmlFor="org-add-member-role" label={t("Role (optional)")}>
                <Input
                    data-testid="org-add-member-role"
                    id="org-add-member-role"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setRole(event.target.value);
                    }}
                    value={role}
                />
            </Field>
        </DialogForm>
    );
};

/** Create a pending email invitation to an organization. */
const MemberInviteDialog = ({ onClose, onDone, organizationId }: { onClose: () => void; onDone: () => void; organizationId: string }): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const [email, setEmail] = useState<string>("");
    const [role, setRole] = useState<string>("");

    const onSubmit = (): void => {
        run(async () => {
            await client.inviteAuthOrgMember({ email: email.trim(), organizationId, role: role.trim() === "" ? undefined : role.trim() });
            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={email.trim() !== ""}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={t("Send invitation")}
            testId="org-invite-member"
            title={t("Invite member")}
        >
            <Field htmlFor="org-invite-member-email" label={t("email")}>
                <Input
                    data-testid="org-invite-member-email"
                    id="org-invite-member-email"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setEmail(event.target.value);
                    }}
                    type="email"
                    value={email}
                />
            </Field>
            <Field htmlFor="org-invite-member-role" label={t("Role (optional)")}>
                <Input
                    data-testid="org-invite-member-role"
                    id="org-invite-member-role"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setRole(event.target.value);
                    }}
                    value={role}
                />
            </Field>
        </DialogForm>
    );
};

/** Change a member's role (comma-separate for multiple roles). */
const MemberRoleDialog = ({ member, onClose, onDone }: { member: Row; onClose: () => void; onDone: () => void }): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    // Lazy initialiser: the eager form re-ran `formatCell` on every render and threw the result away.
    const [role, setRole] = useState<string>(() => formatCell(member["role"]));

    const onSubmit = (): void => {
        run(async () => {
            await client.setAuthOrgMemberRole({ memberId: formatCell(member["id"]), role: role.trim() });
            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={role.trim() !== ""}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={t("Save")}
            testId="org-member-role"
            title={t("Change member role")}
        >
            <Field htmlFor="org-member-role-value" label={t("Role")}>
                <Input
                    data-testid="org-member-role-value"
                    id="org-member-role-value"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setRole(event.target.value);
                    }}
                    value={role}
                />
            </Field>
        </DialogForm>
    );
};

/** Create or rename a team. */
const TeamFormDialog = ({
    mode,
    onClose,
    onDone,
    organizationId,
    team,
}: {
    mode: "create" | "edit";
    onClose: () => void;
    onDone: () => void;
    organizationId: string;
    team?: Row;
}): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const [name, setName] = useState<string>(team ? formatCell(team["name"]) : "");

    const onSubmit = (): void => {
        run(async () => {
            await (mode === "create"
                ? client.createAuthOrgTeam({ name: name.trim(), organizationId })
                : client.updateAuthOrgTeam({ name: name.trim(), teamId: formatCell(team?.["id"]) }));

            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={name.trim() !== ""}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={mode === "create" ? t("Create") : t("Save")}
            testId="org-team-form"
            title={mode === "create" ? t("New team") : t("Rename team")}
        >
            <Field htmlFor="org-team-form-name" label={t("name")}>
                <Input
                    data-testid="org-team-form-name"
                    id="org-team-form-name"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setName(event.target.value);
                    }}
                    value={name}
                />
            </Field>
        </DialogForm>
    );
};

/** Add an existing user (by id) to a team. */
const TeamMemberAddDialog = ({ onClose, onDone, teamId }: { onClose: () => void; onDone: () => void; teamId: string }): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const [userId, setUserId] = useState<string>("");

    const onSubmit = (): void => {
        run(async () => {
            await client.addAuthOrgTeamMember({ teamId, userId: userId.trim() });
            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={userId.trim() !== ""}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={t("Add member")}
            testId="org-team-add-member"
            title={t("Add team member")}
        >
            <Field htmlFor="org-team-add-member-user" label={t("User id")}>
                <Input
                    data-testid="org-team-add-member-user"
                    id="org-team-add-member-user"
                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                        setUserId(event.target.value);
                    }}
                    value={userId}
                />
            </Field>
        </DialogForm>
    );
};

/** Create or edit a custom org role and its permission grant. */
const RoleFormDialog = ({
    mode,
    onClose,
    onDone,
    organizationId,
    role,
}: {
    mode: "create" | "edit";
    onClose: () => void;
    onDone: () => void;
    organizationId: string;
    role?: Row;
}): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const [name, setName] = useState<string>(role ? formatCell(role["role"]) : "");
    const [permission, setPermission] = useState<string>(mode === "edit" ? jsonInitial(role?.["permission"]) : "");

    const onSubmit = (): void => {
        run(async () => {
            const grant = parsePermission(permission);

            await (mode === "create"
                ? client.createAuthOrgRole({ organizationId, permission: grant, role: name.trim() })
                : client.updateAuthOrgRole({ permission: grant, roleId: formatCell(role?.["id"]) }));

            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit={permission.trim() !== "" && (mode === "edit" || name.trim() !== "")}
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={mode === "create" ? t("Create") : t("Save")}
            testId="org-role-form"
            title={mode === "create" ? t("New role") : t("Edit role")}
        >
            {mode === "create" && (
                <Field htmlFor="org-role-form-name" label={t("Role name")}>
                    <Input
                        data-testid="org-role-form-name"
                        id="org-role-form-name"
                        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                            setName(event.target.value);
                        }}
                        value={name}
                    />
                </Field>
            )}
            <Field htmlFor="org-role-form-permission" label={t('Permission (JSON, e.g. {"project":["create","update"]})')}>
                <Textarea
                    data-testid="org-role-form-permission"
                    id="org-role-form-permission"
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
                        setPermission(event.target.value);
                    }}
                    value={permission}
                />
            </Field>
        </DialogForm>
    );
};

/** Confirm a destructive action (org / team / role deletion) before it runs. */
const ConfirmDialog = ({
    action,
    message,
    onClose,
    onDone,
    testId,
    title,
}: {
    action: () => Promise<void>;
    message: string;
    onClose: () => void;
    onDone: () => void;
    testId: string;
    title: string;
}): ReactElement => {
    const t = useT();
    const { busy, error, run } = useAsyncSubmit();

    const onSubmit = (): void => {
        run(async () => {
            await action();
            onDone();
            onClose();
        });
    };

    return (
        <DialogForm
            busy={busy}
            canSubmit
            destructive
            error={error}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={t("Delete")}
            testId={testId}
            title={title}
        >
            <p className="text-sm text-muted-foreground">{message}</p>
        </DialogForm>
    );
};

export { ConfirmDialog, MemberAddDialog, MemberInviteDialog, MemberRoleDialog, OrgFormDialog, RoleFormDialog, TeamFormDialog, TeamMemberAddDialog };
