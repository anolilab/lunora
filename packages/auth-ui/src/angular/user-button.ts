/**
 * The signed-in-user chrome, mirroring the React `user-button.tsx` 1:1: the
 * avatar (photo or initials), the avatar + name + email block, and the avatar
 * menu with sign-out.
 */
import type { ElementRef, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, signal, viewChild } from "@angular/core";

import type { SessionActions, SessionState } from "../core/session";
import { createSessionController, userInitials, userLabel } from "../core/session";
import { signOut } from "../core/session-actions";
import type { AuthUser } from "../core/types";
import { controllerSignal } from "./controller-signal";
import { injectAuthUIContext } from "./provider";

/**
 * A user's photo, or their initials when there isn't one.
 *
 * The image is the only thing here that can fail at runtime, so a broken URL
 * falls back to the initials rather than to a browser's broken-image glyph —
 * `user.image` is a plain string column an app can put anything in.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-user-avatar",
    standalone: true,
    template: `
        @if (showImage()) {
            <img class="lunora-auth-avatar" alt="" [src]="user()?.image" [style.height.px]="size()" [style.width.px]="size()" (error)="failed.set(true)" />
        } @else {
            <span class="lunora-auth-avatar lunora-auth-avatar--initials" aria-hidden="true" [style.height.px]="size()" [style.width.px]="size()">
                {{ initials() }}
            </span>
        }
    `,
})
class UserAvatarComponent {
    readonly size = input(32);
    readonly user = input<AuthUser>();

    /*
     * A new user means a new image URL, so a previous failure must not stick to
     * it. `linkedSignal` is Angular's version of React's adjust-state-during-render
     * pattern: the flag is writable, and resets itself whenever the URL it
     * describes changes.
     */
    protected readonly failed = linkedSignal<string | undefined, boolean>({
        computation: () => false,
        source: () => this.user()?.image,
    });

    protected readonly initials = computed(() => userInitials(this.user()));
    protected readonly showImage = computed(() => {
        const image = this.user()?.image;

        return image !== undefined && image !== "" && !this.failed();
    });
}

/** Avatar + name + email, the block that identifies an account in a list or menu. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [UserAvatarComponent],
    selector: "lunora-user-view",
    standalone: true,
    template: `
        <span class="lunora-auth-user">
            <lunora-user-avatar [size]="compact() ? 24 : 36" [user]="user()" />
            <span class="lunora-auth-user__text">
                <span class="lunora-auth-user__name">{{ label() }}</span>
                @if (!compact() && user()?.email !== undefined) {
                    <span class="lunora-auth-user__email">{{ user()?.email }}</span>
                }
            </span>
        </span>
    `,
})
class UserViewComponent {
    /** Hide the email line, for tight rows. */
    readonly compact = input(false);
    readonly user = input<AuthUser>();

    protected readonly label = computed(() => userLabel(this.user()));
}

let menuIdCounter = 0;

/** A DOM id per instance. Hoisted out of the template literal so the increment is a statement, not an expression buried in a string. */
const nextId = (prefix: string): string => {
    menuIdCounter += 1;

    return `${prefix}${String(menuIdCounter)}`;
};

/**
 * The avatar menu: who is signed in, plus sign-out and whatever the app hangs
 * off it.
 *
 * It is a disclosure rather than a `&lt;menu>` because its contents are app-defined
 * — links, an organization switcher, a theme row — and forcing those into menu
 * item semantics would mislabel them. Escape and outside-click close it, and
 * focus returns to the trigger, which is the part hand-rolled dropdowns usually
 * miss.
 *
 * Extra rows are projected: anything between the tags renders above sign-out.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        "(document:keydown.escape)": "onEscape()",
        "(document:mousedown)": "onPointerDown($event)",
    },
    imports: [UserAvatarComponent, UserViewComponent],
    selector: "lunora-user-button",
    standalone: true,
    template: `
        <!--
          "Not asked yet" and "asked, nobody home" look identical in the user
          field, and rendering a sign-in link during the first request makes
          every page flash one. "settled" is the difference.
        -->
        @if (!session().settled) {
            <span class="lunora-auth-userbutton lunora-auth-userbutton--loading"></span>
        } @else if (!session().user) {
            @if (!hideWhenSignedOut()) {
                <a class="lunora-auth-link" [href]="signInHref()">{{ t.signIn }}</a>
            }
        } @else {
            <div class="lunora-auth-userbutton" #root>
                <button
                    class="lunora-auth-userbutton__trigger"
                    type="button"
                    #trigger
                    aria-haspopup="true"
                    [attr.aria-controls]="open() ? menuId : null"
                    [attr.aria-expanded]="open()"
                    [attr.aria-label]="userLabel(session().user)"
                    (click)="open.set(!open())"
                >
                    <lunora-user-avatar [user]="session().user" />
                </button>
                @if (open()) {
                    <div class="lunora-auth-userbutton__menu" [id]="menuId">
                        <div class="lunora-auth-userbutton__header">
                            <lunora-user-view [user]="session().user" />
                        </div>
                        <ng-content />
                        <button class="lunora-auth-button lunora-auth-button--secondary" type="button" (click)="signOut()">{{ t.signOut }}</button>
                    </div>
                }
            </div>
        }
    `,
})
class UserButtonComponent {
    /** Render nothing at all when signed out, instead of a sign-in link. */
    readonly hideWhenSignedOut = input(false);

    // Per-instance id: two buttons on one page must not collide.
    protected readonly menuId = nextId("lunora-auth-userbutton-");
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createSessionController, { context: this.context });
    protected readonly session: Signal<SessionState> = this.bridge.state;
    private readonly actions: SessionActions = this.bridge.actions;

    protected readonly open = signal(false);
    protected readonly signInHref = computed(() => this.context().redirects.signIn);

    private readonly root = viewChild<ElementRef<HTMLElement>>("root");
    private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>("trigger");

    /** Delegates to the shared helper — Angular templates can only call members. */
    protected readonly userLabel = userLabel;

    protected onEscape(): void {
        if (!this.open()) {
            return;
        }

        this.open.set(false);
        this.trigger()?.nativeElement.focus();
    }

    protected onPointerDown(event: MouseEvent): void {
        const root = this.root()?.nativeElement;

        if (this.open() && root && !root.contains(event.target as Node)) {
            // Focus is deliberately left alone: a click elsewhere is the user
            // moving on, and yanking it back to the trigger would fight them for it.
            this.open.set(false);
        }
    }

    protected signOut(): void {
        this.open.set(false);
        void signOut(this.context()).then(this.actions.refetch);
    }
}

export { UserAvatarComponent, UserButtonComponent, UserViewComponent };
