/**
 * Rich, keyboard-driven prompts for the CLI's interactive surfaces (init / add),
 * rendered with `@visulima/tui` (an Ink-style React terminal runtime).
 *
 * These mirror the signatures of `@lunora/config`'s readline prompts exactly, so
 * a CLI handler can swap one for the other with no call-site change — the config
 * versions stay the lightweight default (used by the Vite plugin and as the
 * non-TTY fallback), while the CLI defaults to these.
 *
 * Policy, identical to the readline helpers: when stdin is not a TTY (CI / piped)
 * or there are no options, never render — return the supplied default so
 * automation never blocks. Escape (and Ctrl-C) cancels back to the default too.
 */
/* eslint-disable react-refresh/only-export-components, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-array-as-prop -- render-once CLI prompt module, not an HMR app surface: components mount once per prompt and unmount on submit, so co-locating the promise-wrapping helpers is intended and inline callback/array props carry no re-render cost. */
import type { MultiSelectOption, SelectOption } from "@lunora/config";
import { isInteractive } from "@lunora/config";
import { render } from "@visulima/tui";
import { Box } from "@visulima/tui/components/box";
import { ConfirmInput } from "@visulima/tui/components/confirm-input";
import { MultiSelect } from "@visulima/tui/components/multi-select";
import { SelectInput } from "@visulima/tui/components/select-input";
import { Text } from "@visulima/tui/components/text";
import { useApp } from "@visulima/tui/hooks/use-app";
import { useInput } from "@visulima/tui/hooks/use-input";
import type { ReactElement } from "react";

/** Lunora's accent (purple) for the focused item + checkmarks. */
const ACCENT = "#a855f7";

/**
 * Render an Ink element to a promise. `build` receives a `finish` callback; the
 * component calls it with the result and then `exit()`s. `waitUntilExit()`
 * resolves when the app exits (a normal finish, Escape, or Ctrl-C); if `finish`
 * never ran (cancel) or the app errored, the supplied `fallback` is returned.
 */
const runInkPrompt = async <R,>(build: (finish: (result: R) => void) => ReactElement, fallback: R): Promise<R> => {
    // `result` starts as the fallback and only changes when the component calls
    // `finish` — so a cancel (Escape / Ctrl-C, which never calls `finish`) leaves
    // the fallback in place. No separate "finished" flag needed.
    let result = fallback;

    const instance = render(
        build((value) => {
            result = value;
        }),
        { exitOnCtrlC: true },
    );

    try {
        await instance.waitUntilExit();
    } catch {
        // Ctrl-C / render error → keep the fallback.
    } finally {
        instance.unmount();
    }

    return result;
};

/** Fold an option's `description` into its label, since the tui list items render a single line. */
const itemLabel = (option: { description?: string; label: string }): string =>
    option.description === undefined ? option.label : `${option.label} — ${option.description}`;

interface SelectViewProps<T extends string> {
    finish: (value: T) => void;
    initialIndex: number | undefined;
    message: string;
    options: ReadonlyArray<SelectOption<T>>;
}

const SelectView = <T extends string>({ finish, initialIndex, message, options }: SelectViewProps<T>): ReactElement => {
    const { exit } = useApp();

    // Escape cancels without choosing — runInkPrompt then returns the default.
    useInput((_input, key) => {
        if (key.escape) {
            exit();
        }
    });

    return (
        <Box flexDirection="column">
            <Text bold>{message}</Text>
            <SelectInput
                accentColor={ACCENT}
                initialIndex={initialIndex}
                items={options.map((option) => {
                    return { key: option.value, label: itemLabel(option), value: option.value };
                })}
                onSelect={(item) => {
                    finish(item.value);
                    exit();
                }}
            />
        </Box>
    );
};

/**
 * Pick one option from an arrow-key list (Enter selects, Escape cancels). Mirrors
 * `@lunora/config`'s `promptSelect`: non-interactive ⇒ returns `settings.default`.
 */
const tuiSelect = async <T extends string>(message: string, options: ReadonlyArray<SelectOption<T>>, settings?: { default?: T }): Promise<T | undefined> => {
    if (!isInteractive() || options.length === 0) {
        return settings?.default;
    }

    const defaultIndex = settings?.default === undefined ? -1 : options.findIndex((option) => option.value === settings.default);

    return runInkPrompt<T | undefined>(
        (finish) => <SelectView finish={finish} initialIndex={defaultIndex >= 0 ? defaultIndex : undefined} message={message} options={options} />,
        settings?.default,
    );
};

interface MultiSelectViewProps<T extends string> {
    defaults: ReadonlyArray<T>;
    finish: (values: T[]) => void;
    message: string;
    options: ReadonlyArray<MultiSelectOption<T>>;
}

const MultiSelectView = <T extends string>({ defaults, finish, message, options }: MultiSelectViewProps<T>): ReactElement => {
    const { exit } = useApp();

    useInput((_input, key) => {
        if (key.escape) {
            exit();
        }
    });

    return (
        <Box flexDirection="column">
            <Text bold>{message}</Text>
            <Text dimColor>space toggles · enter confirms · esc cancels</Text>
            <MultiSelect
                accentColor={ACCENT}
                defaultValue={[...defaults]}
                onSubmit={(values) => {
                    const chosen = new Set(values);
                    // Preserve option order and dedupe; values are option `value`s (⊆ T).
                    finish(options.filter((option) => chosen.has(option.value)).map((option) => option.value));
                    exit();
                }}
                options={options.map((option) => {
                    return { key: option.value, label: itemLabel(option), value: option.value };
                })}
            />
        </Box>
    );
};

/**
 * Pick zero or more options with checkboxes (space toggles, Enter submits, Escape
 * cancels). Mirrors `@lunora/config`'s `promptMultiSelect`: non-interactive ⇒
 * returns `settings.defaults ?? []`.
 */
const tuiMultiSelect = async <T extends string>(
    message: string,
    options: ReadonlyArray<MultiSelectOption<T>>,
    settings?: { defaults?: ReadonlyArray<T> },
): Promise<T[]> => {
    const defaults = settings?.defaults ?? [];

    if (!isInteractive() || options.length === 0) {
        return [...defaults];
    }

    return runInkPrompt<T[]>((finish) => <MultiSelectView defaults={defaults} finish={finish} message={message} options={options} />, [...defaults]);
};

interface ConfirmViewProps {
    defaultYes: boolean;
    finish: (value: boolean) => void;
    message: string;
}

const ConfirmView = ({ defaultYes, finish, message }: ConfirmViewProps): ReactElement => {
    const { exit } = useApp();

    return (
        <Box>
            <Text bold>{message} </Text>
            <ConfirmInput
                defaultChoice={defaultYes ? "confirm" : "cancel"}
                onCancel={() => {
                    finish(false);
                    exit();
                }}
                onConfirm={() => {
                    finish(true);
                    exit();
                }}
            />
        </Box>
    );
};

/**
 * Ask a yes/no question (Y/n). Mirrors `@lunora/config`'s `promptYesNo`:
 * non-interactive ⇒ returns `options.defaultYes === true`.
 */
const tuiConfirm = async (message: string, options?: { defaultYes?: boolean }): Promise<boolean> => {
    const defaultYes = options?.defaultYes === true;

    if (!isInteractive()) {
        return defaultYes;
    }

    return runInkPrompt<boolean>((finish) => <ConfirmView defaultYes={defaultYes} finish={finish} message={message} />, defaultYes);
};

export { tuiConfirm, tuiMultiSelect, tuiSelect };
