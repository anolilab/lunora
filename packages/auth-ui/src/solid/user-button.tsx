import type { JSX } from "solid-js";
import { createEffect, createSignal, createUniqueId, on, onCleanup, Show } from "solid-js";

import { createSessionController, userInitials, userLabel } from "../core/session";
import { signOut } from "../core/session-actions";
import type { AuthUser } from "../core/types";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/**
 * A user's photo, or their initials when there isn't one.
 *
 * The image is the only thing here that can fail at runtime, so a broken URL
 * falls back to the initials rather than to a browser's broken-image glyph —
 * `user.image` is a plain string column an app can put anything in.
 */
interface UserAvatarProps {
    size?: number;
    user?: AuthUser;
}

const UserAvatar = (props: UserAvatarProps): JSX.Element => {
    const [failed, setFailed] = createSignal(false);
    const image = (): string | undefined => props.user?.image;

    // A new user means a new image URL, so a previous failure must not stick to
    // it. Deferred, because the initial run would only re-clear a fresh signal.
    createEffect(
        on(
            image,
            () => {
                setFailed(false);
            },
            { defer: true },
        ),
    );

    const style = (): JSX.CSSProperties => {
        const size = props.size ?? 32;

        return { height: `${String(size)}px`, width: `${String(size)}px` };
    };

    const source = (): string | undefined => {
        const value = image();

        return value === undefined || value === "" || failed() ? undefined : value;
    };

    return (
        <Show
            fallback={
                <span aria-hidden="true" class="lunora-auth-avatar lunora-auth-avatar--initials" style={style()}>
                    {userInitials(props.user)}
                </span>
            }
            when={source()}
        >
            {/* `Show` hands the narrowed URL to the callback — no cast needed. */}
            {(url) => (
                <img
                    alt=""
                    class="lunora-auth-avatar"
                    onError={() => {
                        setFailed(true);
                    }}
                    src={url()}
                    style={style()}
                />
            )}
        </Show>
    );
};

/** Avatar + name + email, the block that identifies an account in a list or menu. */
interface UserViewProps {
    /** Hide the email line, for tight rows. */
    compact?: boolean;
    user?: AuthUser;
}

const UserView = (props: UserViewProps): JSX.Element => (
    <span class="lunora-auth-user">
        <UserAvatar size={props.compact === true ? 24 : 36} user={props.user} />
        <span class="lunora-auth-user__text">
            <span class="lunora-auth-user__name">{userLabel(props.user)}</span>
            <Show when={props.compact !== true && props.user?.email !== undefined}>
                <span class="lunora-auth-user__email">{props.user?.email}</span>
            </Show>
        </span>
    </span>
);

/**
 * The avatar menu: who is signed in, plus sign-out and whatever the app hangs
 * off it.
 *
 * It is a disclosure rather than a `<menu>` because its contents are app-defined
 * — links, an organization switcher, a theme row — and forcing those into menu
 * item semantics would mislabel them. Escape and outside-click close it, and
 * focus returns to the trigger, which is the part hand-rolled dropdowns usually
 * miss.
 */
interface UserButtonProps {
    /** Extra rows rendered above sign-out (links, an org switcher, …). */
    children?: JSX.Element;
    /** Render nothing at all when signed out, instead of a sign-in link. */
    hideWhenSignedOut?: boolean;
}

const UserButton = (props: UserButtonProps): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [session, sessionActions] = createController(createSessionController);
    const [open, setOpen] = createSignal(false);
    const menuId = createUniqueId();
    /*
     * Callback refs rather than Solid's `ref={root}` shorthand. The shorthand is
     * rewritten to an assignment by the compiler, which static analysis cannot
     * see — CodeQL then proves the `root &&` guard below is always false and
     * flags it as dead code. Assigning explicitly keeps the guard (a listener
     * can fire before the element is attached) and keeps the analyser honest.
     */
    let root: HTMLDivElement | undefined;
    let trigger: HTMLButtonElement | undefined;

    const close = (): void => {
        setOpen(false);
        trigger?.focus();
    };

    createEffect(() => {
        if (!open()) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                close();
            }
        };

        const onPointerDown = (event: MouseEvent): void => {
            if (root && !root.contains(event.target as Node)) {
                // Not `close()`: a click elsewhere is the user moving on, and
                // yanking focus back to the trigger would fight them for it.
                setOpen(false);
            }
        };

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);

        onCleanup(() => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("mousedown", onPointerDown);
        });
    });

    return (
        // "Not asked yet" and "asked, nobody home" look identical in `user`, and
        // rendering a sign-in link during the first request makes every page
        // flash one. `settled` is the difference.
        <Show fallback={<span class="lunora-auth-userbutton lunora-auth-userbutton--loading" />} when={session.settled}>
            <Show
                fallback={
                    <Show when={props.hideWhenSignedOut !== true}>
                        <a class="lunora-auth-link" href={context.redirects.signIn}>
                            {t.signIn}
                        </a>
                    </Show>
                }
                when={session.user}
            >
                {/* `Show` hands the narrowed user to the callback — no cast needed. */}
                {(user) => (
                    <div
                        class="lunora-auth-userbutton"
                        ref={(element) => {
                            root = element;
                        }}
                    >
                        <button
                            aria-controls={open() ? menuId : undefined}
                            aria-expanded={open()}
                            aria-haspopup="true"
                            aria-label={userLabel(user())}
                            class="lunora-auth-userbutton__trigger"
                            onClick={() => {
                                setOpen((value) => !value);
                            }}
                            ref={(element) => {
                                trigger = element;
                            }}
                            type="button"
                        >
                            <UserAvatar user={user()} />
                        </button>
                        <Show when={open()}>
                            <div class="lunora-auth-userbutton__menu" id={menuId}>
                                <div class="lunora-auth-userbutton__header">
                                    <UserView user={user()} />
                                </div>
                                {props.children}
                                <button
                                    class="lunora-auth-button lunora-auth-button--secondary"
                                    onClick={() => {
                                        setOpen(false);
                                        void signOut(context).then(sessionActions.refetch);
                                    }}
                                    type="button"
                                >
                                    {t.signOut}
                                </button>
                            </div>
                        </Show>
                    </div>
                )}
            </Show>
        </Show>
    );
};

export type { UserAvatarProps, UserButtonProps, UserViewProps };
export { UserAvatar, UserButton, UserView };
