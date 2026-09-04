/**
 * Rich, keyboard-driven prompts for the CLI's interactive surfaces (init / add),
 * rendered with `@visulima/tui` (an Ink-style React terminal runtime) and its
 * `@visulima/tui-kit` widget set.
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
/* eslint-disable react-refresh/only-export-components, react-perf/jsx-no-new-function-as-prop -- render-once CLI prompt module, not an HMR app surface: components mount once per prompt and unmount on submit, so co-locating the promise-wrapping helpers is intended and inline callback/array props carry no re-render cost. */
import type { BadgeSpec, MultiSelectOption, SelectOption } from "@lunora/config";
import { ACCENT, BADGE_COLUMN_WIDTH, badgeLead, badgeWidth, isInteractive, LUNA_ART, LUNA_NAME, LUNA_SIGNOFF, padBadge } from "@lunora/config";
import { render } from "@visulima/tui";
import { Box } from "@visulima/tui/components/box";
import { Text } from "@visulima/tui/components/text";
import { useApp } from "@visulima/tui/hooks/use-app";
import { useInput } from "@visulima/tui/hooks/use-input";
import { useInterval } from "@visulima/tui/hooks/use-interval";
import { CommandPalette } from "@visulima/tui-kit/command-palette";
import { ConfirmInput } from "@visulima/tui-kit/confirm-input";
import { SelectInput } from "@visulima/tui-kit/select-input";
import { Spinner } from "@visulima/tui-kit/spinner";
import { TextInput } from "@visulima/tui-kit/text-input";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useEffect, useState } from "react";

import { PromptCancelledError } from "./prompt-cancelled";

/**
 * `@visulima/tui`'s `render` attaches a `process` `beforeExit` listener per
 * mount and doesn't always detach it on unmount; a single `init` flow mounts
 * ~20 prompts/steps, tripping Node's default 10-listener `MaxListenersExceeded`
 * warning. Raise the cap once, lazily (so importing this module stays
 * side-effect-free), the first time we render.
 */
let listenerCapRaised = false;

const raiseListenerCap = (): void => {
    if (listenerCapRaised) {
        return;
    }

    listenerCapRaised = true;

    if (process.getMaxListeners() < 64) {
        process.setMaxListeners(64);
    }
};

/**
 * Owns Ctrl-C while a prompt or task block is live: records the cancel AND exits
 * the app itself. We deliberately render with `exitOnCtrlC: false` so the runtime
 * does NOT short-circuit and tear down before this handler runs — otherwise the
 * cancel would go unrecorded and the caller would resolve with the prompt's
 * default (silently advancing to the next question instead of aborting).
 */
const CtrlCGuard = ({ children, onCancel }: { children: ReactElement; onCancel: () => void }): ReactElement => {
    const { exit } = useApp();

    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            onCancel();
            exit();
        }
    });

    return children;
};

/** Normalize a caught (unknown) task failure into an Error for rethrow. */
const toError = (failure: unknown): Error => {
    if (failure instanceof Error) {
        return failure;
    }

    return new Error(typeof failure === "string" ? failure : "task failed");
};

/** Visible rows before a select/multiselect list scrolls. */
const SCROLL_LIMIT = 10;

/** Above this many options a plain list gets unwieldy, so `tuiSelect` switches to the searchable palette. */
const FILTER_THRESHOLD = 8;

/**
 * A create-astro-style step badge: right-aligning lead spaces + the colored
 * ` text ` box, so badges line up in a gutter (` ▸ dir `, `tmpl`, `lunora`).
 */
const Badge = ({ spec }: { spec: BadgeSpec }): ReactElement => (
    <Text>
        <Text>{badgeLead(spec.text)}</Text>
        <Text backgroundColor={spec.bg} bold color={spec.fg}>
            {padBadge(spec.text)}
        </Text>
    </Text>
);

/**
 * A prompt's title line — the bare bold message, or (when a step badge is given)
 * the badge followed by the message, so the prompt reads like a transcript row.
 */
const PromptHeader = ({ badge, message }: { badge: BadgeSpec | undefined; message: string }): ReactElement =>
    badge === undefined ? (
        <Text bold>{message}</Text>
    ) : (
        <Box>
            <Badge spec={badge} />
            <Text bold>{` ${message}`}</Text>
        </Box>
    );

/** The body indent that aligns a prompt's input / answer under the message (past the badge gutter). */
const BODY_INDENT = 2;

/**
 * Lead spaces that right-align the `✔`/`◼` header glyph within the badge gutter,
 * so it ends at the same column the badge boxes do (one glyph is one cell, so the
 * lead is one column short of the gutter width). With a single trailing space the
 * header text then lands at the badge MESSAGE column — identical to every
 * prompt/transcript row and to the gradient-bar label — so the title never shifts.
 */
const HEADER_INDENT = " ".repeat(BADGE_COLUMN_WIDTH - 1);

/** Spaces that align a step's dimmed answer under its question (the full badge column + the message's leading space). */
const badgeIndent = (badge: BadgeSpec): string => " ".repeat(badgeWidth(badge) + 1);

/** Columns to indent a prompt's active body so it lines up under the message (and with the answered value). */
const bodyIndent = (badge: BadgeSpec | undefined): number => (badge === undefined ? BODY_INDENT : badgeWidth(badge) + 1);

/**
 * Borderless prompt shell — create-astro/clack style: the badge + question on
 * one line, the interactive body (input or option list) indented beneath it.
 * The body indent matches {@link AnsweredLine}'s, so the value stays put when the
 * prompt collapses on submit (no left-to-right jump). Replaces the old full-width
 * rounded box, which dominated the terminal.
 */
const PromptShell = ({
    badge,
    children,
    message,
}: {
    badge: BadgeSpec | undefined;
    children: ReactElement | ReactElement[];
    message: string;
}): ReactElement => (
    <Box flexDirection="column">
        <PromptHeader badge={badge} message={message} />
        <Box flexDirection="column" marginLeft={bodyIndent(badge)}>
            {children}
        </Box>
    </Box>
);

/**
 * The compact "answered" line a prompt collapses to on submit: the badge +
 * question with the chosen value dimmed beneath it. `@visulima/tui` leaves a
 * mounted app's final frame in scrollback, so rendering this as the view's last
 * frame IS the persistent transcript row — no separate echo needed (a separate
 * echo would double the line).
 */
const AnsweredLine = ({ answer, badge, message }: { answer: string; badge: BadgeSpec | undefined; message: string }): ReactElement => (
    <Box flexDirection="column">
        <PromptHeader badge={badge} message={message} />
        {answer === "" ? null : <Text dimColor>{`${badge === undefined ? " ".repeat(BODY_INDENT) : badgeIndent(badge)}${answer}`}</Text>}
    </Box>
);

/**
 * Submit handling shared by every prompt view: record the result for
 * `runInkPrompt`, swap the view to its {@link AnsweredLine} final frame, then
 * exit once that frame has painted (so it — not the input widget — is what
 * persists). `answer === undefined` means "still interacting".
 */
const useAnswer = <R,>(finish: (result: R) => void): { answer: string | undefined; submit: (result: R, display: string) => void } => {
    const { exit } = useApp();
    const [answer, setAnswer] = useState<string | undefined>(undefined);

    // Deliberate effect (not an inline handler): we must let the AnsweredLine
    // frame PAINT before exiting, so the persisted final frame is the answer —
    // exiting synchronously in `submit` would tear down before that render.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- the paint-then-exit ordering requires the effect; see above.
        if (answer !== undefined) {
            exit();
        }
    }, [answer, exit]);

    return {
        answer,
        submit: (result, display) => {
            finish(result);
            setAnswer(display);
        },
    };
};

/** Mounts a frame, exits after the first paint so it stays in scrollback (intro/outro/step lines). */
const SelfExit = ({ children }: { children: ReactElement }): ReactElement => {
    const { exit } = useApp();

    useEffect(() => {
        exit();
    }, [exit]);

    return children;
};

const printFrame = async (element: ReactElement): Promise<void> => {
    raiseListenerCap();

    // create-astro-style breathing room: one blank line above every rendered block.
    process.stdout.write("\n");

    const instance = render(<SelfExit>{element}</SelfExit>);

    try {
        await instance.waitUntilExit();
    } catch {
        // Best-effort banner — never block the flow on a render hiccup.
    } finally {
        instance.unmount();
    }
};

/**
 * Print a persistent transcript row into scrollback: the step badge + message,
 * and (optionally) the chosen answer dimmed on the line below, aligned under the
 * message. The interactive twin of the pail `LunoraReporter` step lines, and what
 * the badge-aware prompts echo on submit. No-op off a TTY.
 */
const tuiStep = async (badge: BadgeSpec, message: string, answer?: string): Promise<void> => {
    if (!isInteractive()) {
        return;
    }

    const answerLines = answer === undefined || answer === "" ? [] : answer.split("\n");

    await printFrame(
        <Box flexDirection="column">
            <PromptHeader badge={badge} message={message} />
            {answerLines.map((line) => (
                <Text dimColor key={line}>
                    {`${badgeIndent(badge)}${line}`}
                </Text>
            ))}
        </Box>,
    );
};

/**
 * The one render harness shared by every live tui surface (prompts, the task
 * checklist, the badge-progress run): open one blank line, mount `element` under
 * a {@link CtrlCGuard} with the runtime's own Ctrl-C handling disabled (so the
 * guard — not the runtime — owns it), wait for exit, always unmount, and throw
 * {@link PromptCancelledError} if the user pressed Ctrl-C. Callers read their own
 * result through a closure they wire into `element` before calling this.
 */
const runInkApp = async (element: ReactElement): Promise<void> => {
    raiseListenerCap();

    // One blank line above each surface, so they read as separated blocks.
    process.stdout.write("\n");

    // Holder (not a bare `let`) so the mutation inside `onCancel` isn't narrowed
    // away to "always false" by the type-aware linter.
    const cancel = { value: false };

    const instance = render(
        <CtrlCGuard
            onCancel={() => {
                cancel.value = true;
            }}
        >
            {element}
        </CtrlCGuard>,
        { exitOnCtrlC: false },
    );

    try {
        await instance.waitUntilExit();
    } finally {
        instance.unmount();
    }

    if (cancel.value) {
        throw new PromptCancelledError();
    }
};

/**
 * Render a prompt to a promise. `build` receives a `finish` callback; the
 * component calls it with the result and then `exit()`s. The result starts as
 * `fallback` and only changes when `finish` runs — so a non-committing exit
 * (Escape) keeps the fallback, while Ctrl-C aborts via {@link runInkApp}.
 */
const runInkPrompt = async <R,>(build: (finish: (result: R) => void) => ReactElement, fallback: R): Promise<R> => {
    let result = fallback;

    await runInkApp(
        build((value) => {
            result = value;
        }),
    );

    return result;
};

/** Fold an option's `description` into its label, since the tui list items render a single line. */
const itemLabel = (option: { description?: string; label: string }): string =>
    option.description === undefined ? option.label : `${option.label} — ${option.description}`;

/** Wire Escape to cancel a prompt (exits without committing → `runInkPrompt` returns the fallback). */
const useEscapeToExit = (): void => {
    const { exit } = useApp();

    useInput((_input, key) => {
        if (key.escape) {
            exit();
        }
    });
};

interface SelectViewProps<T extends string> {
    badge: BadgeSpec | undefined;
    finish: (value: T) => void;
    initialIndex: number | undefined;
    message: string;
    options: ReadonlyArray<SelectOption<T>>;
}

const SelectView = <T extends string>({ badge, finish, initialIndex, message, options }: SelectViewProps<T>): ReactElement => {
    const { answer, submit } = useAnswer(finish);

    useEscapeToExit();

    if (answer !== undefined) {
        return <AnsweredLine answer={answer} badge={badge} message={message} />;
    }

    return (
        <PromptShell badge={badge} message={message}>
            <SelectInput
                accentColor={ACCENT}
                initialIndex={initialIndex}
                items={options.map((option) => {
                    return { key: option.value, label: itemLabel(option), value: option.value };
                })}
                limit={SCROLL_LIMIT}
                onSelect={(item) => {
                    submit(item.value, options.find((option) => option.value === item.value)?.label ?? item.value);
                }}
            />
        </PromptShell>
    );
};

interface PaletteViewProps<T extends string> {
    badge: BadgeSpec | undefined;
    finish: (value: T) => void;
    message: string;
    options: ReadonlyArray<SelectOption<T>>;
}

/**
 * A searchable (type-to-filter) single-select for long option lists. The palette
 * is search-first, so unlike {@link SelectView} it does not pre-highlight
 * `settings.default` — there's nothing focused until the user types or arrows.
 */
const PaletteView = <T extends string>({ badge, finish, message, options }: PaletteViewProps<T>): ReactElement => {
    const { exit } = useApp();
    const { answer, submit } = useAnswer(finish);

    if (answer !== undefined) {
        return <AnsweredLine answer={answer} badge={badge} message={message} />;
    }

    return (
        <PromptShell badge={badge} message={message}>
            <CommandPalette
                accentColor={ACCENT}
                autoFocus
                commands={options.map((option) => {
                    return { description: option.description, id: option.value, label: option.label };
                })}
                limit={SCROLL_LIMIT}
                onCancel={() => {
                    exit();
                }}
                onSelect={(id) => {
                    submit(id as T, options.find((option) => option.value === id)?.label ?? id);
                }}
                placeholder="Type to filter…"
            />
        </PromptShell>
    );
};

/**
 * Pick one option (Enter selects, Escape cancels). Mirrors `@lunora/config`'s
 * `promptSelect`: non-interactive ⇒ returns `settings.default`. Long lists
 * (> {@link FILTER_THRESHOLD}) render the searchable palette; short ones the
 * plain arrow-key list.
 */
const tuiSelect = async <T extends string>(
    message: string,
    options: ReadonlyArray<SelectOption<T>>,
    settings?: { badge?: BadgeSpec; default?: T },
): Promise<T | undefined> => {
    if (!isInteractive() || options.length === 0) {
        return settings?.default;
    }

    const { badge } = settings ?? {};

    if (options.length > FILTER_THRESHOLD) {
        return runInkPrompt<T | undefined>((finish) => <PaletteView badge={badge} finish={finish} message={message} options={options} />, settings?.default);
    }

    const defaultIndex = settings?.default === undefined ? -1 : options.findIndex((option) => option.value === settings.default);

    return runInkPrompt<T | undefined>(
        (finish) => (
            <SelectView badge={badge} finish={finish} initialIndex={defaultIndex >= 0 ? defaultIndex : undefined} message={message} options={options} />
        ),
        settings?.default,
    );
};

interface TextViewProps {
    badge: BadgeSpec | undefined;
    defaultValue: string;
    finish: (value: string) => void;
    message: string;
    placeholder: string | undefined;
}

const TextView = ({ badge, defaultValue, finish, message, placeholder }: TextViewProps): ReactElement => {
    const { answer, submit } = useAnswer(finish);

    useEscapeToExit();

    if (answer !== undefined) {
        return <AnsweredLine answer={answer} badge={badge} message={message} />;
    }

    return (
        <PromptShell badge={badge} message={message}>
            <TextInput
                defaultValue={defaultValue}
                onSubmit={(value) => {
                    // An empty submission keeps the default — never commit "".
                    const chosen = value.trim() === "" ? defaultValue : value.trim();

                    submit(chosen, chosen);
                }}
                placeholder={placeholder}
            />
        </PromptShell>
    );
};

/** A single-line text prompt — {@link tuiText}'s shape; injectable for tests / non-TUI callers. */
type TextPrompt = (message: string, settings?: { badge?: BadgeSpec; default?: string; placeholder?: string }) => Promise<string>;

/**
 * Prompt for a single line of text (Enter submits, Escape keeps the default).
 * Non-interactive ⇒ returns `settings.default` so automation never blocks; an
 * empty submission also falls back to the default.
 */
const tuiText: TextPrompt = async (message, settings) => {
    const fallback = settings?.default ?? "";

    if (!isInteractive()) {
        return fallback;
    }

    const { badge } = settings ?? {};

    return runInkPrompt<string>(
        (finish) => <TextView badge={badge} defaultValue={fallback} finish={finish} message={message} placeholder={settings?.placeholder} />,
        fallback,
    );
};

interface MultiSelectViewProps<T extends string> {
    badge: BadgeSpec | undefined;
    defaults: ReadonlyArray<T>;
    finish: (values: T[]) => void;
    message: string;
    options: ReadonlyArray<MultiSelectOption<T>>;
}

/**
 * Custom multi-select: `◼` selected / `◻` not, `▸` on the cursor row — no trailing
 * checkmark (the box already conveys selection). Space toggles, arrows move, Enter
 * confirms, Escape cancels. Built in-house because the tui `MultiSelect` also draws
 * a redundant trailing `✓` and exposes no item renderer to remove it.
 */
const MultiSelectView = <T extends string>({ badge, defaults, finish, message, options }: MultiSelectViewProps<T>): ReactElement => {
    const { answer, submit } = useAnswer(finish);
    const [cursor, setCursor] = useState(0);
    const [selected, setSelected] = useState<ReadonlySet<T>>(() => new Set(defaults));

    useEscapeToExit();

    useInput((input, key) => {
        if (answer !== undefined || options.length === 0) {
            return;
        }

        if (key.upArrow) {
            setCursor((current) => (current - 1 + options.length) % options.length);
        } else if (key.downArrow) {
            setCursor((current) => (current + 1) % options.length);
        } else if (input === " ") {
            const option = options[cursor];

            if (option !== undefined) {
                setSelected((previous) => {
                    const next = new Set(previous);

                    if (next.has(option.value)) {
                        next.delete(option.value);
                    } else {
                        next.add(option.value);
                    }

                    return next;
                });
            }
        } else if (key.return) {
            const picked = options.filter((option) => selected.has(option.value));

            submit(
                picked.map((option) => option.value),
                picked.length > 0 ? picked.map((option) => option.label).join(", ") : "none",
            );
        }
    });

    if (answer !== undefined) {
        return <AnsweredLine answer={answer} badge={badge} message={message} />;
    }

    return (
        <PromptShell badge={badge} message={message}>
            <Box flexDirection="column">
                <Text dimColor>space toggles · enter confirms · esc cancels</Text>
                {options.map((option, index) => {
                    const onCursor = index === cursor;

                    return (
                        <Text color={onCursor ? ACCENT : undefined} key={option.value}>
                            {`${onCursor ? "▸ " : "  "}${selected.has(option.value) ? "◼" : "◻"} ${itemLabel(option)}`}
                        </Text>
                    );
                })}
            </Box>
        </PromptShell>
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
    settings?: { badge?: BadgeSpec; defaults?: ReadonlyArray<T> },
): Promise<T[]> => {
    const defaults = settings?.defaults ?? [];

    if (!isInteractive() || options.length === 0) {
        return [...defaults];
    }

    const { badge } = settings ?? {};

    return runInkPrompt<T[]>(
        (finish) => <MultiSelectView badge={badge} defaults={defaults} finish={finish} message={message} options={options} />,
        [...defaults],
    );
};

interface ConfirmViewProps {
    badge: BadgeSpec | undefined;
    defaultYes: boolean;
    finish: (value: boolean) => void;
    message: string;
}

const ConfirmView = ({ badge, defaultYes, finish, message }: ConfirmViewProps): ReactElement => {
    const { answer, submit } = useAnswer(finish);

    if (answer !== undefined) {
        return <AnsweredLine answer={answer} badge={badge} message={message} />;
    }

    return (
        <Box>
            {badge === undefined ? null : <Badge spec={badge} />}
            <Text bold>{badge === undefined ? `${message} ` : ` ${message} `}</Text>
            <ConfirmInput
                defaultChoice={defaultYes ? "confirm" : "cancel"}
                onCancel={() => {
                    submit(false, "No");
                }}
                onConfirm={() => {
                    submit(true, "Yes");
                }}
            />
        </Box>
    );
};

/**
 * Ask a yes/no question (Y/n). Mirrors `@lunora/config`'s `promptYesNo`:
 * non-interactive ⇒ returns `options.defaultYes === true`. Pass the bare
 * question — the Y/n indicator is rendered for you (don't append "[y/N]").
 *
 * `defaultYes` drives the Enter default (via `ConfirmInput`), but a cancel —
 * Escape or Ctrl-C — always declines (`false`): an interrupt must never be read
 * as acceptance, even for a default-yes prompt.
 */
const tuiConfirm = async (message: string, options?: { badge?: BadgeSpec; defaultYes?: boolean }): Promise<boolean> => {
    const defaultYes = options?.defaultYes === true;

    if (!isInteractive()) {
        return defaultYes;
    }

    const { badge } = options ?? {};

    return runInkPrompt<boolean>((finish) => <ConfirmView badge={badge} defaultYes={defaultYes} finish={finish} message={message} />, false);
};

/**
 * A default-yes `confirm(message)` for the scaffolders (`ensureDevVariables`),
 * the TUI analogue of `@lunora/config`'s `createConfirm`: an interactive Y/n
 * prompt on a TTY, or an immediate `false` otherwise — so CI declines silently
 * instead of blocking (note: NOT `tuiConfirm`'s default-passthrough, which would
 * return the default off a TTY).
 */
const createTuiConfirm = (): ((message: string) => Promise<boolean>) =>
    isInteractive() ? (message: string) => tuiConfirm(message, { defaultYes: true }) : () => Promise.resolve(false);

/** Starfield + moon colors for the moonrise header (variant G). */
const STAR_BRIGHT = "#c8a8ff";

const MOON_LIGHT = "#d9c8ff";

const MOON_FACE = "#6b5b9a";

/** One row of the moon art: a dim starfield prefix, the light moon body (with darker craters), and a star suffix. */
const MoonRow = ({ moon, prefix, suffix }: { moon: ReactElement | string; prefix: string; suffix?: string }): ReactElement => (
    <Box>
        <Text color={STAR_BRIGHT} dimColor>
            {prefix}
        </Text>
        {typeof moon === "string" ? <Text color={MOON_LIGHT}>{moon}</Text> : moon}
        {suffix === undefined ? null : <Text color={STAR_BRIGHT}>{suffix}</Text>}
    </Box>
);

/** The moon's two craters, drawn darker than the body. */
const MoonFace = ({ left, right }: { left: string; right: string }): ReactElement => (
    <Text color={MOON_LIGHT}>
        {left}
        <Text color={MOON_FACE}>●●</Text>
        {right}
    </Text>
);

/**
 * The "moonrise" header (variant G): a faint starfield with an ASCII moon in the
 * upper right and the `lunora init · moonrise sequence` label. Reused by the
 * banner and the wizard so the header stays put while steps change beneath it.
 */
const MoonriseHeader = (): ReactElement => (
    <Box flexDirection="column" paddingX={1}>
        <MoonRow moon=".-‐-." prefix="·      ✦          ·      " suffix="     ✦" />
        <MoonRow moon={<MoonFace left="/" right="\" />} prefix="      ✦      ·           " suffix="   ·" />
        <MoonRow moon={<MoonFace left="\" right="/" />} prefix="  .        ✦      ·      " />
        <Box>
            <Text bold color={ACCENT}>
                {"      lunora init "}
            </Text>
            <Text dimColor>· moonrise sequence</Text>
            <Text color={MOON_LIGHT} />
        </Box>
    </Box>
);

/**
 * Print the moonrise header once at the top of `lunora init`. No-op off a TTY.
 * `subtitle`, when given, is dimmed beneath the art.
 */
const tuiMoonrise = async (subtitle?: string): Promise<void> => {
    if (!isInteractive()) {
        return;
    }

    await printFrame(
        <Box flexDirection="column">
            <MoonriseHeader />
            {subtitle === undefined ? null : (
                <Box paddingX={1}>
                    <Text dimColor>{subtitle}</Text>
                </Box>
            )}
        </Box>,
    );
};

const SpinnerView = ({ label }: { label: string }): ReactElement => (
    <Box>
        <Text color={ACCENT}>
            <Spinner type="dots" />
        </Text>
        <Text> {label}</Text>
    </Box>
);

/**
 * Run an async task behind a live spinner, returning the task's result. On a
 * non-TTY (CI / piped) the spinner is skipped and the task runs bare, so logs
 * stay clean. The spinner always stops (unmounts) even if the task throws.
 */
const withTuiSpinner = async <T,>(label: string, task: () => Promise<T>): Promise<T> => {
    if (!isInteractive()) {
        return task();
    }

    raiseListenerCap();

    const instance = render(<SpinnerView label={label} />);

    try {
        return await task();
    } finally {
        instance.unmount();
    }
};

/**
 * Sign off with Luna — the bunny-ears-in-a-black-hole mascot — the way
 * create-astro closes with Houston: the ASCII art beside the name + farewell.
 * No-op off a TTY (the fallback prints the same art through the logger).
 */
const tuiMascot = async (): Promise<void> => {
    if (!isInteractive()) {
        return;
    }

    await printFrame(
        <Box paddingX={1}>
            <Text color={MOON_LIGHT}>{LUNA_ART}</Text>
            <Box flexDirection="column" marginLeft={2}>
                <Text bold color={ACCENT}>
                    {LUNA_NAME}
                </Text>
                <Text>{LUNA_SIGNOFF}</Text>
            </Box>
        </Box>,
    );
};

/** Cyan used for the `◼` info marker. */
const INFO_CYAN = "#06b6d4";

/** Indent for the prose lines in the next-steps block (aligns under the badge text). */
const PROSE_INDENT = " ".repeat(9);

/**
 * A plain section headline — a bold line with no badge, indented to align with
 * the question text of the badged prompts that follow it (the `add` extras
 * offer). No-op off a TTY.
 */
const tuiHeadline = async (message: string): Promise<void> => {
    if (!isInteractive()) {
        return;
    }

    await printFrame(<Text bold>{`${PROSE_INDENT}${message}`}</Text>);
};

/**
 * A standalone info note: `      ◼  message`. Used for the gentle follow-ups when
 * the user declines an offer (install / git). No-op off a TTY.
 */
const tuiInfo = async (message: string): Promise<void> => {
    if (!isInteractive()) {
        return;
    }

    await printFrame(
        <Box>
            <Text color={INFO_CYAN}>{`${HEADER_INDENT}◼`}</Text>
            <Text>{`  ${message}`}</Text>
        </Box>,
    );
};

interface NextStep {
    /** The accent-colored command/url fragment. */
    code: string;
    /** Plain lead-in before the code. */
    lead: string;
    /** Plain text after the code. */
    tail?: string;
}

/**
 * The closing "next steps" block (create-astro layout): the `next` badge + a bold
 * headline, then prose lines indented beneath it with their commands accented,
 * and a closing help line. No-op off a TTY (the logger fallback covers piped).
 */
const tuiNextSteps = async (badge: BadgeSpec, header: string, steps: ReadonlyArray<NextStep>, help: ReadonlyArray<NextStep>): Promise<void> => {
    if (!isInteractive()) {
        return;
    }

    await printFrame(
        <Box flexDirection="column">
            <PromptHeader badge={badge} message={header} />
            <Box flexDirection="column" marginTop={1}>
                {steps.map((step) => (
                    <Text key={step.lead}>
                        {`${PROSE_INDENT}${step.lead} `}
                        <Text color={ACCENT}>{step.code}</Text>
                        {step.tail ?? ""}
                    </Text>
                ))}
            </Box>
            <Box flexDirection="column" marginTop={1}>
                {help.map((line) => (
                    <Text key={line.lead}>
                        {`${PROSE_INDENT}${line.lead} `}
                        <Text color={ACCENT}>{line.code}</Text>
                        {line.tail ?? ""}
                    </Text>
                ))}
            </Box>
        </Box>,
    );
};

type TaskStatus = "done" | "failed" | "pending" | "running";

interface TaskSpec<T> {
    label: string;
    run: () => Promise<T>;
}

/** Lunora's gradient for the "rocket-flame" task spinner — purple → cyan, the badge hues. */
const SPINNER_FIRST = "#a855f7";

const SPINNER_LAST = "#06b6d4";

const SPINNER_COLORS = [SPINNER_FIRST, "#9b51f6", "#8a5cf6", "#6f86f6", "#4aa6ef", "#2bb6dd", "#12bcd0", SPINNER_LAST];

const SPINNER_BAR_WIDTH = SPINNER_COLORS.length - 2;

/** A run of `count` copies of `value` (typed string[]). */
// eslint-disable-next-line e18e/prefer-array-fill -- the mapfn form keeps the result typed as string[]; `.fill` on `Array.from({length})` yields unknown[].
const repeatColor = (count: number, value: string): string[] => Array.from({ length: Math.max(0, count) }, () => value);

/** A long reference strip the visible window scrolls across, so the gradient appears to flow. */
const SPINNER_STRIP: string[] = [
    ...repeatColor(SPINNER_COLORS.length - 1, SPINNER_FIRST),
    ...SPINNER_COLORS,
    ...repeatColor(SPINNER_COLORS.length - 1, SPINNER_LAST),
    ...SPINNER_COLORS.toReversed(),
];

/** Each animation frame is a `SPINNER_BAR_WIDTH`-wide window into the strip, padded to width. */
const SPINNER_FRAMES: string[][] = SPINNER_STRIP.map((_, offset) => {
    const window = SPINNER_STRIP.slice(offset, offset + SPINNER_BAR_WIDTH);

    return [...window, ...repeatColor(SPINNER_BAR_WIDTH - window.length, SPINNER_FIRST)];
});

/**
 * Lead spaces that right-align the gradient bar within the badge gutter, so its
 * right edge lands at the same column the badge boxes (`dir`, `tmpl`, `add`, …)
 * end at. With a single trailing space the label then sits at the badge MESSAGE
 * column — so the bar reads as one more right-aligned badge in the same gutter.
 */
const SPINNER_LEAD = " ".repeat(Math.max(0, BADGE_COLUMN_WIDTH - SPINNER_BAR_WIDTH));

/**
 * The animated gradient bar + header text, rendered as a single line so the text
 * sits immediately after the bar: `  ██████ Project initializing…`. The bar is
 * right-aligned in the badge gutter (see {@link SPINNER_LEAD}) so it lines up with
 * the `dir`/`tmpl`/`add` badges, and the label lands at the shared message column.
 */
const GradientSpinner = ({ label }: { label: string }): ReactElement => {
    const [index, setIndex] = useState(0);

    useInterval(() => {
        setIndex((previous) => (previous + 1) % SPINNER_FRAMES.length);
    }, 90);

    const colors = SPINNER_FRAMES[index % SPINNER_FRAMES.length] ?? [];

    return (
        <Text>
            {SPINNER_LEAD}
            {colors.map((color, blockIndex) => (
                // eslint-disable-next-line react-x/no-array-index-key -- fixed-length gradient bar that never reorders.
                <Text color={color} key={blockIndex}>
                    █
                </Text>
            ))}
            {` ${label}`}
        </Text>
    );
};

/** A sub-task row: `□` pending (dim), `▶` active (accent), `■` done (dim), `✖` failed (red). */
const TaskRow = ({ label, status }: { label: string; status: TaskStatus }): ReactElement => {
    if (status === "running") {
        return <Text color={ACCENT}>{`${HEADER_INDENT}▶ ${label}`}</Text>;
    }

    if (status === "failed") {
        return <Text color="red">{`${HEADER_INDENT}✖ ${label}`}</Text>;
    }

    if (status === "done") {
        return <Text dimColor>{`${HEADER_INDENT}■ ${label}`}</Text>;
    }

    return <Text dimColor>{`${HEADER_INDENT}□ ${label}`}</Text>;
};

interface TasksViewProps<T> {
    end: string;
    onSettle: (results: T[], failure: unknown) => void;

    /**
     * Called as the task chain is kicked off, so the caller knows a settlement
     * is actually coming. Without it a caller cannot tell "still running" from
     * "never started" — and only the first of those is worth waiting for.
     */
    onStart: () => void;
    start: string;
    tasks: ReadonlyArray<TaskSpec<T>>;
}

/**
 * Run the task list sequentially, reporting each transition through `mark`, and
 * resolve with the collected results plus the first failure (if any). Never
 * rejects — a task error is captured into `failure` and stops the run.
 *
 * `isCancelled` is checked before each task starts. A task already in flight
 * cannot be stopped (none of them take a signal), but no LATER one begins:
 * Ctrl-C throws `PromptCancelledError` out of the render immediately while this
 * chain keeps running, so `lunora init` would remove the partially-created
 * project and the orphaned chain would then re-run `copyTemplate` and re-create
 * the whole thing, right under the "removed the partially-created project" line
 * the user just read.
 */
const runTaskList = async <T,>(
    tasks: ReadonlyArray<TaskSpec<T>>,
    mark: (index: number, status: TaskStatus) => void,
    isCancelled: () => boolean,
): Promise<{ failure: unknown; results: T[] }> => {
    const results: T[] = [];
    let failure: unknown;

    for (const [index, task] of tasks.entries()) {
        if (isCancelled()) {
            break;
        }

        mark(index, "running");

        try {
            // eslint-disable-next-line no-await-in-loop -- tasks run sequentially by design (one active row at a time).
            results.push(await task.run());
            mark(index, "done");
        } catch (error) {
            mark(index, "failed");
            failure = error;

            break;
        }
    }

    return { failure, results };
};

/**
 * Kick off the task list and wire its completion back to the view: report each
 * transition through `setStatuses`, and on settle call `onSettle` + `exit`.
 * Returns the effect cleanup that disarms the callbacks if the view unmounts
 * first. Extracted from the component so the promise chain isn't nested inside
 * the render function.
 */
const startTasks = <T,>(
    tasks: ReadonlyArray<TaskSpec<T>>,
    setStatuses: Dispatch<SetStateAction<TaskStatus[]>>,
    onSettle: (results: T[], failure: unknown) => void,
    exit: () => void,
): (() => void) => {
    let active = true;

    const mark = (index: number, status: TaskStatus): void => {
        if (active) {
            setStatuses((previous) => previous.map((value, position) => (position === index ? status : value)));
        }
    };

    runTaskList(tasks, mark, () => !active)
        .then(({ failure, results }) => {
            // Reported even after an unmount (Ctrl-C), so the caller can WAIT for
            // this chain to stop touching the disk before it undoes what the
            // chain wrote. Only the exit + the paint hold are gated on `active`.
            onSettle(results, failure);

            // Hold briefly so the final "done" frame (green ✔ header + settled rows)
            // paints before we tear the app down — otherwise the last setState races
            // the exit and the header never flips to green.
            setTimeout(() => {
                if (active) {
                    exit();
                }
            }, 400);

            return undefined;
        })
        .catch((error: unknown) => {
            // runTaskList captures task failures into its result; this only guards
            // an unexpected reject. It must still settle, or a caller awaiting the
            // chain on the Ctrl-C path would wait forever.
            onSettle([], error);
        });

    return () => {
        active = false;
    };
};

const TasksView = <T,>({ end, onSettle, onStart, start, tasks }: TasksViewProps<T>): ReactElement => {
    const { exit } = useApp();
    const [statuses, setStatuses] = useState<TaskStatus[]>(() => tasks.map(() => "pending"));

    useEffect(() => {
        onStart();

        return startTasks(tasks, setStatuses, onSettle, exit);
    }, [exit, onSettle, onStart, tasks]);

    const allDone = statuses.length > 0 && statuses.every((status) => status === "done");

    // create-astro layout: a header (gradient "rocket" bar + start text while
    // working; `✔  <end>` when done), then the sub-steps directly beneath it.
    return (
        <Box flexDirection="column">
            {allDone ? (
                <Box>
                    <Text bold color="green">
                        {`${HEADER_INDENT}✔`}
                    </Text>
                    <Text bold color="green">
                        {` ${end}`}
                    </Text>
                </Box>
            ) : (
                <GradientSpinner label={start} />
            )}
            {tasks.map((task, index) => (
                <TaskRow key={task.label} label={task.label} status={statuses[index] ?? "pending"} />
            ))}
        </Box>
    );
};

/**
 * Run a sequence of async tasks as a live checklist with the create-astro look: a
 * gradient "rocket" header that flips to `✔  <end>` when done, over `□`/`▶`/`■`
 * sub-steps. Returns each task's result. Off a TTY the tasks run bare (no render)
 * and the first failure rejects, exactly like {@link withTuiSpinner}.
 */
const tuiTasks = async <T,>(tasks: ReadonlyArray<TaskSpec<T>>, labels: { end: string; start: string }): Promise<T[]> => {
    if (!isInteractive()) {
        const results: T[] = [];

        for (const task of tasks) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design.
            results.push(await task.run());
        }

        return results;
    }

    let results: T[] = [];
    let failure: unknown;
    let markSettled = (): void => {};
    // Armed by `onStart`, and only then: resolves once the task chain has
    // stopped — including after a Ctrl-C, where the render throws immediately
    // but the in-flight task is still writing.
    //
    // Left `undefined` while no chain has started. `@visulima/tui` attaches its
    // Ctrl-C listener in a LAYOUT effect while `TasksView` starts the chain in a
    // PASSIVE one, so an interrupt in between ends the app with nothing ever
    // calling `onSettle` — and the unconditional wait below then never resolved,
    // hanging the CLI instead of surfacing the interrupt.
    let settled: Promise<void> | undefined;

    try {
        await runInkApp(
            <TasksView
                end={labels.end}
                onSettle={(settledResults, settledFailure) => {
                    results = settledResults;
                    failure = settledFailure;
                    markSettled();
                }}
                onStart={() => {
                    settled = new Promise<void>((resolve) => {
                        markSettled = resolve;
                    });
                }}
                start={labels.start}
                tasks={tasks}
            />,
        );
    } catch (error) {
        // Ctrl-C. `runTaskList`'s gate stops any LATER task, but the one already
        // running cannot be interrupted — so wait for it before letting the
        // caller undo what it wrote. Without this, `lunora init` removed the
        // partially-created project and the still-running copy re-created it.
        //
        // `await undefined` when no chain ever started: nothing is writing, so
        // there is nothing to wait for.
        await settled;

        throw error;
    }

    if (failure !== undefined) {
        throw toError(failure);
    }

    return results;
};

/** One step of a {@link withTuiBadgeProgress} run: a label shown while it works and the task it runs. */
interface ProgressStep<T> {
    running: string;
    task: () => Promise<T>;
}

/** Settled outcome of a {@link BadgeProgressView} run: the collected values, or the thrown error. */
type ProgressOutcome<T> = { error: unknown; ok: false } | { ok: true; values: T[] };

interface BadgeProgressViewProps<T> {
    badge: BadgeSpec;
    done: string;
    onSettle: (outcome: ProgressOutcome<T>) => void;
    steps: ReadonlyArray<ProgressStep<T>>;
}

/**
 * Run the steps in sequence, reporting the active step through `mark`, and resolve
 * with the collected values plus the first failure (if any). Never rejects — a task
 * error is captured into `failure` and stops the run.
 */
const runProgressSteps = async <T,>(steps: ReadonlyArray<ProgressStep<T>>, mark: (index: number) => void): Promise<{ failure: unknown; values: T[] }> => {
    const values: T[] = [];
    let failure: unknown;

    for (const [index, step] of steps.entries()) {
        mark(index);

        try {
            // eslint-disable-next-line no-await-in-loop -- steps run sequentially by design (one changing label at a time).
            values.push(await step.task());
        } catch (error) {
            failure = error;

            break;
        }
    }

    return { failure, values };
};

/**
 * A run of indeterminate tasks rendered as ONE project-style line: the animated
 * gradient bar (`██████  adding auth…`) whose label changes to each step's `running`
 * text as the run advances, then — once every step settles — the line collapses into
 * a single persistent `badge` transcript row (`add  added auth, storage`). One log
 * line for the whole batch, not one spinner per task.
 */
const BadgeProgressView = <T,>({ badge, done, onSettle, steps }: BadgeProgressViewProps<T>): ReactElement => {
    const { exit } = useApp();
    const [index, setIndex] = useState(0);
    const [finished, setFinished] = useState(false);

    // Deliberate effect: drive the sequential run on mount, advancing the label per
    // step, then flip to the done frame and hold briefly so the settled `add` row
    // paints before teardown (same 400ms window as startTasks).
    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const mark = (next: number): void => {
            if (active) {
                setIndex(next);
            }
        };

        runProgressSteps(steps, mark)
            .then(({ failure, values }) => {
                if (!active) {
                    return undefined;
                }

                if (failure !== undefined) {
                    onSettle({ error: failure, ok: false });
                    exit();

                    return undefined;
                }

                setFinished(true);
                timer = setTimeout(() => {
                    if (active) {
                        onSettle({ ok: true, values });
                        exit();
                    }
                }, 400);

                return undefined;
            })
            .catch(() => {
                // runProgressSteps captures task failures into its result; this only guards an unexpected reject.
            });

        return () => {
            active = false;

            if (timer !== undefined) {
                clearTimeout(timer);
            }
        };
    }, [exit, onSettle, steps]);

    return finished ? <PromptHeader badge={badge} message={done} /> : <GradientSpinner label={steps[index]?.running ?? ""} />;
};

/**
 * Run a sequence of async tasks behind ONE project-style gradient bar whose label
 * changes per step, then collapse it into a single persistent `badge` line on
 * success — returning each task's result in order. Off a TTY the tasks run bare (no
 * render), exactly like {@link withTuiSpinner}. The render always tears down even if a
 * task throws.
 */
const withTuiBadgeProgress = async <T,>(badge: BadgeSpec, steps: ReadonlyArray<ProgressStep<T>>, done: string): Promise<T[]> => {
    if (!isInteractive()) {
        const values: T[] = [];

        for (const step of steps) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design.
            values.push(await step.task());
        }

        return values;
    }

    let outcome: ProgressOutcome<T> | undefined;

    await runInkApp(
        <BadgeProgressView
            badge={badge}
            done={done}
            onSettle={(settled) => {
                outcome = settled;
            }}
            steps={steps}
        />,
    );

    if (outcome === undefined) {
        // The render exited before the run settled — treat as a cancel.
        throw new PromptCancelledError();
    }

    if (!outcome.ok) {
        throw toError(outcome.error);
    }

    return outcome.values;
};

export {
    createTuiConfirm,
    runTaskList,
    tuiConfirm,
    tuiHeadline,
    tuiInfo,
    tuiMascot,
    tuiMoonrise,
    tuiMultiSelect,
    tuiNextSteps,
    tuiSelect,
    tuiStep,
    tuiTasks,
    tuiText,
    withTuiBadgeProgress,
    withTuiSpinner,
};
export type { NextStep, TextPrompt };
