import type { ReturnOf } from "@lunora/client";
import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import type { UsageAlertMeter, UsageThresholdSuggestion } from "../telemetry/usage-alerts";
import { Field } from "./section-ui";
import type { OrgId } from "./types";
import { suggestionLine, USAGE_METER_CHOICES, usageThresholdValue } from "./usage-alert";

/** The project select's value for "the whole organization" — a Select item cannot carry an empty value. */
const WHOLE_ORGANIZATION = "*";

/** A project the scope select offers. */
type ProjectChoice = Pick<ReturnOf<typeof api.projects.listByOrg>[number], "_id" | "name">;

/** A monthly usage rule being drafted: the fields the form shows, and what it sends. */
export interface UsageRuleDraft {
    /** The usage-only arguments of `alerts.createRule`, threshold included; spread over the generic ones. */
    args: { meter: UsageAlertMeter; projectId?: ProjectChoice["_id"]; threshold: number };
    meter: UsageAlertMeter;
    projectId: ProjectChoice["_id"] | undefined;
    projects: ReadonlyArray<ProjectChoice> | undefined;
    setMeter: (meter: UsageAlertMeter) => void;
    setProjectId: (projectId: ProjectChoice["_id"] | undefined) => void;
    setThreshold: (threshold: string) => void;
    suggestion: undefined | UsageThresholdSuggestion;
    /** The threshold field's value: typed, else the suggestion. */
    threshold: string;
}

/**
 * The draft of a monthly usage rule. The threshold the member has not typed
 * follows the suggestion for the chosen meter (`alerts.suggestUsageThreshold`),
 * derived at render; choosing another meter drops what was typed, so the new
 * meter's suggestion shows. Reads nothing while `active` is false.
 */
export const useUsageRuleDraft = (organizationId: OrgId, active: boolean): UsageRuleDraft => {
    const [meter, setMeterState] = useState<UsageAlertMeter>("requests");
    const [typed, setTyped] = useState<null | string>(null);
    const [projectId, setProjectId] = useState<ProjectChoice["_id"] | undefined>(undefined);
    const suggestion = useQuery(api.alerts.suggestUsageThreshold, active ? { meter, organizationId } : "skip");
    const projects = useQuery(api.projects.listByOrg, active ? { organizationId } : "skip");
    const threshold = usageThresholdValue(typed, suggestion);

    return {
        args: { meter, threshold: Number(threshold), ...(projectId === undefined ? {} : { projectId }) },
        meter,
        projectId,
        projects,
        setMeter: (next) => {
            setMeterState(next);
            setTyped(null);
        },
        setProjectId,
        setThreshold: setTyped,
        suggestion,
        threshold,
    };
};

/** Each meter's label, so the closed select shows it rather than the meter's key. */
const METER_ITEMS: Record<string, string> = Object.fromEntries(USAGE_METER_CHOICES.map((choice) => [choice.value, choice.label]));

/** Which meter a usage rule watches. */
const MeterField = ({ draft }: { draft: UsageRuleDraft }): ReactElement => (
    <Field htmlFor="alert-meter" label="Meter">
        <Select
            items={METER_ITEMS}
            onValueChange={(value: unknown) => {
                draft.setMeter(value as UsageAlertMeter);
            }}
            value={draft.meter}
        >
            <SelectTrigger id="alert-meter">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {USAGE_METER_CHOICES.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    </Field>
);

/** Whose usage counts: the whole organization, or one project. */
const ScopeField = ({ draft }: { draft: UsageRuleDraft }): ReactElement => (
    <Field htmlFor="alert-project" label="Project (optional)">
        <Select
            items={{ [WHOLE_ORGANIZATION]: "Whole organization", ...Object.fromEntries((draft.projects ?? []).map((project) => [project._id, project.name])) }}
            onValueChange={(value: unknown) => {
                draft.setProjectId(value === WHOLE_ORGANIZATION ? undefined : (value as ProjectChoice["_id"]));
            }}
            value={draft.projectId ?? WHOLE_ORGANIZATION}
        >
            <SelectTrigger id="alert-project">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    <SelectItem value={WHOLE_ORGANIZATION}>Whole organization</SelectItem>
                    {(draft.projects ?? []).map((project) => (
                        <SelectItem key={project._id} value={project._id}>
                            {project.name}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    </Field>
);

/**
 * The fields of a monthly usage rule: the meter, whose usage counts, and the
 * monthly quantity in the meter's unit, pre-filled with the suggestion and
 * explained by last month's usage.
 */
export const UsageRuleFields = ({ draft }: { draft: UsageRuleDraft }): ReactElement => {
    const unit = USAGE_METER_CHOICES.find((choice) => choice.value === draft.meter)?.unit ?? "";
    const line = suggestionLine(draft.suggestion, draft.projectId !== undefined);

    return (
        <>
            <MeterField draft={draft} />
            <ScopeField draft={draft} />
            <div className="grid gap-1.5 sm:col-span-2">
                <Field htmlFor="alert-usage-threshold" label={`Alert when this month passes (${unit})`}>
                    <Input
                        className="font-mono tabular-nums"
                        id="alert-usage-threshold"
                        min={1}
                        onChange={(event) => {
                            draft.setThreshold(event.target.value);
                        }}
                        required
                        type="number"
                        value={draft.threshold}
                    />
                </Field>
                {line === undefined ? null : <p className="text-muted-foreground m-0 text-xs">{line}</p>}
            </div>
        </>
    );
};
