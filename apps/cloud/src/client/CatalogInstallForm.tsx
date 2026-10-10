import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { CatalogForm, FormSecret, FormVariable } from "../catalog/artifact";
import { initialValues, withoutBlanks } from "./catalog-values";
import { Field, FieldForm, FormError } from "./section-ui";
import type { OrgId } from "./types";

/** An install runs a deploy, so it gets far longer than a browse before the client gives up. */
const INSTALL_TIMEOUT_MS = 120_000;

const GENERATED_NOTE = "Generated on first install";
const KEPT_NOTE = "Kept from the earlier install";

export interface ProjectOption {
    _id: string;
    name: string;
}

/** A refused install is a value, so the form can show its `field`; only a transport failure throws. */
type InstallOutcome = { field?: string; message: string; ok: false } | { generated: string[]; kept: string[]; ok: true };

interface CatalogInstallFormProps {
    form: CatalogForm;
    onClose: () => void;
    onInstalled: () => void;
    organizationId: OrgId;
    projects: ProjectOption[];
    slug: string;
}

const installRequest = async (body: Record<string, unknown>): Promise<InstallOutcome> => {
    const response = await fetch("/v1/catalog/install", {
        body: JSON.stringify(body),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as { error?: string; field?: string; generated?: string[]; kept?: string[] } | null;

    if (!response.ok || !payload?.generated) {
        return {
            ...(payload?.field === undefined ? {} : { field: payload.field }),
            message: payload?.error ?? `could not install the app (HTTP ${String(response.status)})`,
            ok: false,
        };
    }

    // `kept` is not in every response yet; its absence means nothing was kept.
    return { generated: payload.generated, kept: payload.kept ?? [], ok: true };
};

/** The one line an install failure is shown on: the server's error, and the field it names if any. */
const failureText = (outcome: InstallOutcome | null): null | string => {
    if (outcome === null || outcome.ok) {
        return null;
    }

    return outcome.field === undefined ? outcome.message : `${outcome.message} (${outcome.field})`;
};

interface VariableFieldProps {
    fieldId: string;
    onChange: (name: string, value: string) => void;
    value: string;
    variable: FormVariable;
}

const VariableField = ({ fieldId, onChange, value, variable }: VariableFieldProps): ReactElement => {
    const handleChange = (event: { target: { value: string } }): void => {
        onChange(variable.name, event.target.value);
    };

    return (
        <Field htmlFor={fieldId} label={`${variable.label}${variable.required ? " *" : ""}`}>
            <Input id={fieldId} onChange={handleChange} placeholder={variable.description ?? variable.name} required={variable.required} value={value} />
        </Field>
    );
};

interface SecretFieldProps {
    fieldId: string;
    keptNames: ReadonlyArray<string>;
    onChange: (name: string, value: string) => void;
    secret: FormSecret;
    value: string;
}

/** A generated secret has no input at all: the server makes its value and it is never shown or accepted. */
const SecretField = ({ fieldId, keptNames, onChange, secret, value }: SecretFieldProps): ReactElement => {
    const handleChange = (event: { target: { value: string } }): void => {
        onChange(secret.name, event.target.value);
    };

    return (
        <Field htmlFor={fieldId} label={`${secret.label}${secret.required ? " *" : ""}`}>
            {secret.generate === undefined ? (
                <Input
                    autoComplete="off"
                    id={fieldId}
                    onChange={handleChange}
                    placeholder={secret.description ?? secret.name}
                    required={secret.required}
                    type="password"
                    value={value}
                />
            ) : (
                <p className="text-sm text-muted-foreground">{keptNames.includes(secret.name) ? KEPT_NOTE : GENERATED_NOTE}</p>
            )}
        </Field>
    );
};

/**
 * The install form for one app, built from its declared form. Vars are text
 * inputs prefilled from their default; secrets are password inputs, except a
 * generated one, which the server fills in. Blank values are not sent, so an
 * unfilled optional var takes its default and a blank generated secret is generated.
 *
 * Nothing is preselected: the project must be chosen, and the install replaces
 * that project's production release, so it also needs an explicit confirmation.
 * Choosing another project clears the confirmation.
 */
export const CatalogInstallForm = ({ form, onClose, onInstalled, organizationId, projects, slug }: CatalogInstallFormProps): ReactElement => {
    const [projectId, setProjectId] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [keptNames, setKeptNames] = useState<string[]>([]);
    const [values, setValues] = useState(() => initialValues(form));
    const [pending, setPending] = useState(false);
    const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
    const selectedProject = projects.find((project) => project._id === projectId);
    const fieldId = (kind: string, fieldName: string): string => `catalog-${slug}-${kind}-${fieldName}`;

    const handleProjectChange = (value: string | null): void => {
        setProjectId(value ?? "");
        setConfirmed(false);
        setKeptNames([]);
        setOutcome(null);
    };

    const handleConfirmChange = (event: { target: { checked: boolean } }): void => {
        setConfirmed(event.target.checked);
    };

    const setVariable = (variableName: string, value: string): void => {
        setValues((current) => {
            return { ...current, vars: { ...current.vars, [variableName]: value } };
        });
    };

    const setSecret = (secretName: string, value: string): void => {
        setValues((current) => {
            return { ...current, secrets: { ...current.secrets, [secretName]: value } };
        });
    };

    const submitInstall = async (): Promise<void> => {
        if (selectedProject === undefined) {
            return;
        }

        setPending(true);
        setOutcome(null);

        try {
            const result = await installRequest({
                organizationId,
                projectId: selectedProject._id,
                slug,
                values: { secrets: withoutBlanks(values.secrets), vars: withoutBlanks(values.vars) },
            });

            setOutcome(result);

            if (result.ok) {
                setConfirmed(false);
                setKeptNames(result.kept);
                onInstalled();
            }
        } catch (error: unknown) {
            setOutcome({ message: error instanceof Error ? error.message : "could not install the app", ok: false });
        } finally {
            setPending(false);
        }
    };

    const handleSubmit = (): void => {
        void submitInstall();
    };

    return (
        <FieldForm action={handleSubmit} className="max-w-2xl sm:grid-cols-2">
            <Field htmlFor={fieldId("project", "select")} label="Project">
                <Select onValueChange={handleProjectChange} value={selectedProject?._id ?? null}>
                    <SelectTrigger id={fieldId("project", "select")}>
                        <SelectValue placeholder="Select a project…" />
                    </SelectTrigger>
                    <SelectContent>
                        {projects.map((project) => (
                            <SelectItem key={project._id} value={project._id}>
                                {project.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>

            {form.vars.map((variable) => (
                <VariableField
                    fieldId={fieldId("var", variable.name)}
                    key={variable.name}
                    onChange={setVariable}
                    value={values.vars[variable.name] ?? ""}
                    variable={variable}
                />
            ))}

            {form.secrets.map((secret) => (
                <SecretField
                    fieldId={fieldId("secret", secret.name)}
                    keptNames={keptNames}
                    key={secret.name}
                    onChange={setSecret}
                    secret={secret}
                    value={values.secrets[secret.name] ?? ""}
                />
            ))}

            {selectedProject === undefined ? null : (
                <div className="flex items-start gap-2 text-sm sm:col-span-2">
                    <input checked={confirmed} className="mt-0.5" id={fieldId("confirm", "replace")} onChange={handleConfirmChange} required type="checkbox" />
                    <label htmlFor={fieldId("confirm", "replace")}>{`Replace the production release of ${selectedProject.name}`}</label>
                </div>
            )}

            <div className="flex items-center gap-3 sm:col-span-2">
                <Button disabled={pending || selectedProject === undefined || !confirmed} type="submit">
                    {pending ? "Installing…" : "Install"}
                </Button>
                <Button disabled={pending} onClick={onClose} type="button" variant="ghost">
                    Close
                </Button>
                {outcome?.ok ? <p className="text-sm text-success">Installed. Generated: {outcome.generated.join(", ") || "nothing"}</p> : null}
            </div>
            <div className="sm:col-span-2">
                <FormError message={failureText(outcome)} />
            </div>
        </FieldForm>
    );
};
