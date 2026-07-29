import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import type { PolicyScaffoldRequest, PolicyScaffoldResult } from "../../lib/policy-scaffold";
import { applyPolicyScaffold } from "../../lib/policy-scaffold";

/** Which scaffolder form is open, if any. */
type Mode = "scaffold" | "wire" | null;

/** The scaffolder's text inputs across both forms; one `useState` keyed by field name. */
interface ScaffolderForm {
    /** Wire form: exported procedure name to wire. */
    readonly exportName: string;
    /** Wire form: lunora-relative module path of the procedure file. */
    readonly filePath: string;
    /** Wire form: identifier of the policy set passed to `rls(...)`. */
    readonly policies: string;
    /** Scaffold form: base name for the file + exported policy set. */
    readonly policyName: string;
    /** Scaffold form: logical table the policy guards. */
    readonly tableName: string;
}

const EMPTY_FORM: ScaffolderForm = { exportName: "", filePath: "", policyName: "", policies: "", tableName: "" };

/**
 * Local-dev access-rule scaffolder (plan 025 Item 3). Two additive actions over
 * the dev host's local policy-scaffold endpoint — never the worker admin RPC.
 * "New policy file" writes a deny-by-default policies stub (definePolicy /
 * definePermission / defineRole, each `when` a `() => false` skeleton the
 * developer fills in) and reruns codegen. "Wire into a procedure" appends a
 * `.use(rls(...))` call to an existing builder chain, preserving the handler.
 *
 * The scaffolder never authors a `when` body or rewrites procedure logic; a
 * destructive request is refused by the host with a manual-edit notice. Mounted
 * only when the permissions panel receives `schemaEditable` (set by the loopback
 * dev hosts), so it is absent from a deployed/read-only studio.
 */
const PolicyScaffolder = (): ReactElement => {
    const t = useT();

    const [mode, setMode] = useState<Mode>(null);
    const [busy, setBusy] = useState<boolean>(false);
    const [result, setResult] = useState<PolicyScaffoldResult | null>(null);

    // One form object across both modes. `filePath` is the lunora-relative module
    // path (no extension); it is explicit rather than derived from a function's
    // path because the generated registry key sanitizes nested directories
    // (`a/b` → `a_b`).
    const [form, setForm] = useState<ScaffolderForm>(EMPTY_FORM);

    const onFieldChange = (event: ChangeEvent<HTMLInputElement>): void => {
        const field = event.target.name as keyof ScaffolderForm;
        const { value } = event.target;

        setForm((previous) => {
            return { ...previous, [field]: value };
        });
    };

    const reset = (): void => {
        setMode(null);
        setForm(EMPTY_FORM);
    };

    const submit = async (request: PolicyScaffoldRequest): Promise<void> => {
        setBusy(true);
        setResult(null);

        try {
            const outcome = await applyPolicyScaffold(request);

            setResult(outcome);

            if (outcome.kind === "ok") {
                reset();
            }
        } catch (error) {
            setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }

        setBusy(false);
    };

    const onSubmitScaffold = (): void => {
        fireAndForget(submit({ kind: "scaffoldPolicy", name: form.policyName.trim(), table: form.tableName.trim() }));
    };

    const onSubmitWire = (): void => {
        fireAndForget(submit({ exportName: form.exportName.trim(), filePath: form.filePath.trim(), kind: "wireRls", policies: form.policies.trim() }));
    };

    const openScaffold = (): void => {
        setResult(null);
        setMode("scaffold");
    };
    const openWire = (): void => {
        setResult(null);
        setMode("wire");
    };

    return (
        <Card data-testid="policy-scaffolder" size="sm">
            <CardHeader>
                <CardTitle>{t("Scaffold access rules")}</CardTitle>
                <CardDescription>
                    {t("Writes a new deny-by-default policy file under lunora/, or wires one into a procedure, then reruns codegen. Local dev only.")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="flex flex-wrap gap-2">
                    <Button
                        data-testid="policy-scaffolder-new"
                        onClick={openScaffold}
                        size="xs"
                        type="button"
                        variant={mode === "scaffold" ? "default" : "outline"}
                    >
                        {t("New policy file")}
                    </Button>
                    <Button data-testid="policy-scaffolder-wire" onClick={openWire} size="xs" type="button" variant={mode === "wire" ? "default" : "outline"}>
                        {t("Wire into a procedure")}
                    </Button>
                </div>

                {mode === "scaffold" && (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="policy-scaffolder-new-form">
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="policy-scaffolder-name">{t("Policy name")}</Label>
                            <Input
                                data-testid="policy-scaffolder-name"
                                id="policy-scaffolder-name"
                                name="policyName"
                                onChange={onFieldChange}
                                value={form.policyName}
                            />
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="policy-scaffolder-table">{t("Table name")}</Label>
                            <Input
                                data-testid="policy-scaffolder-table"
                                id="policy-scaffolder-table"
                                name="tableName"
                                onChange={onFieldChange}
                                value={form.tableName}
                            />
                        </div>
                        <Button
                            data-testid="policy-scaffolder-create"
                            disabled={busy || form.policyName.trim() === "" || form.tableName.trim() === ""}
                            onClick={onSubmitScaffold}
                            size="xs"
                            type="button"
                        >
                            {busy ? t("Creating…") : t("Create policy file")}
                        </Button>
                        <Button onClick={reset} size="xs" type="button" variant="ghost">
                            {t("Cancel")}
                        </Button>
                    </div>
                )}

                {mode === "wire" && (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="policy-scaffolder-wire-form">
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="policy-scaffolder-file">{t("Procedure file path")}</Label>
                            <Input
                                data-testid="policy-scaffolder-file"
                                id="policy-scaffolder-file"
                                name="filePath"
                                onChange={onFieldChange}
                                value={form.filePath}
                            />
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="policy-scaffolder-export">{t("Exported procedure")}</Label>
                            <Input
                                data-testid="policy-scaffolder-export"
                                id="policy-scaffolder-export"
                                name="exportName"
                                onChange={onFieldChange}
                                value={form.exportName}
                            />
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="policy-scaffolder-policies">{t("Policy set identifier")}</Label>
                            <Input
                                data-testid="policy-scaffolder-policies"
                                id="policy-scaffolder-policies"
                                name="policies"
                                onChange={onFieldChange}
                                value={form.policies}
                            />
                        </div>
                        <Button
                            data-testid="policy-scaffolder-apply"
                            disabled={busy || form.filePath.trim() === "" || form.exportName.trim() === "" || form.policies.trim() === ""}
                            onClick={onSubmitWire}
                            size="xs"
                            type="button"
                        >
                            {busy ? t("Wiring…") : t("Wire RLS")}
                        </Button>
                        <Button onClick={reset} size="xs" type="button" variant="ghost">
                            {t("Cancel")}
                        </Button>
                    </div>
                )}

                {result?.kind === "error" && (
                    <p className="mt-3 text-sm text-destructive" data-testid="policy-scaffolder-error" role="alert">
                        {result.message}
                    </p>
                )}

                {result?.kind === "needs-manual-edit" && (
                    <p className="mt-3 text-sm text-amber-600 dark:text-amber-500" data-testid="policy-scaffolder-manual" role="alert">
                        {t("This change must be made by hand — the scaffolder only adds new, deny-by-default rules.")}
                    </p>
                )}

                {result?.kind === "ok" && (
                    <div className="mt-3 flex flex-col gap-1" data-testid="policy-scaffolder-ok">
                        <p className="text-sm text-emerald-600 dark:text-emerald-500">
                            {t("Scaffolded {label} and reran codegen. Fill in the `when` predicates before relying on it.", { label: result.label })}
                        </p>
                        {result.diagnostics.length > 0 && (
                            <ul className="flex flex-col gap-0.5" data-testid="policy-scaffolder-diagnostics">
                                {result.diagnostics.map((diagnostic) => (
                                    <li className="font-mono text-[11px] text-destructive" key={diagnostic}>
                                        {diagnostic}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default PolicyScaffolder;
