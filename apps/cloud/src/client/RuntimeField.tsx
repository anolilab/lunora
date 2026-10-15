import type { ReactElement } from "react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { ProjectRuntime } from "../project-runtime";
import { RUNTIME_LABELS } from "../project-runtime";
import { RUNTIME_CHOICES } from "./runtime-copy";
import { Field } from "./section-ui";

/** The picker for what a project's code is — a Lunora app or a plain Cloudflare Worker — with what the chosen one means for its build. */
export const RuntimeField = ({ id, onChange, value }: { id: string; onChange: (runtime: ProjectRuntime) => void; value: ProjectRuntime }): ReactElement => (
    <Field htmlFor={id} label="Runtime">
        <Select
            items={RUNTIME_LABELS}
            onValueChange={(next: unknown) => {
                onChange(next as ProjectRuntime);
            }}
            value={value}
        >
            <SelectTrigger aria-describedby={`${id}-description`} id={id}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {RUNTIME_CHOICES.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground" id={`${id}-description`}>
            {RUNTIME_CHOICES.find((choice) => choice.value === value)?.description}
        </span>
    </Field>
);
