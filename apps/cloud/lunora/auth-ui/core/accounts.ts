/**
 * Linked accounts (security): list the OAuth providers and credential rows
 * attached to this user, link another, unlink one.
 *
 * Unlinking the last account would lock the user out, so the controller refuses
 * it locally rather than letting the server answer — better-auth does guard
 * this, but a round-trip that can only fail is a worse experience than a
 * disabled button with a reason.
 *
 * `link` is a redirect, not a mutation: it hands off to the provider's OAuth page
 * and the answer arrives as a fresh page load. So it resolves rather than
 * refetching, and the list is correct on the way back in.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import { notifyError } from "./notify-error";
import type { AuthAccount, Controller } from "./types";

/**
 * Providers that are not OAuth links and must never be offered for unlinking as
 * if they were: `credential` is the password itself, and the passkey rows are
 * managed by `<PasskeysCard>`.
 */
const NON_SOCIAL_PROVIDERS = new Set(["credential", "email", "passkey"]);

interface AccountsActions {
    /** Start the OAuth flow to attach `provider` to the signed-in user. */
    link: (provider: string) => Promise<void>;
    refetch: () => Promise<void>;
    /** Detach a provider. Rejected locally when it is the only account left. */
    unlink: (providerId: string, accountId?: string) => Promise<void>;
}

type AccountsController = Controller<ResourceState<AuthAccount>, AccountsActions>;

/** Providers already linked, so a view can render the rest as "available to link". */
const linkedProviderIds = (accounts: ReadonlyArray<AuthAccount>): ReadonlyArray<string> =>
    accounts.map((account) => account.providerId).filter((id): id is string => id !== undefined && !NON_SOCIAL_PROVIDERS.has(id));

/**
 * The providers still available to link: `social` minus what is already
 * attached.
 *
 * Derived here rather than in each view. Every port needs the same complement,
 * and computing it five times meant five chances to forget the
 * {@link NON_SOCIAL_PROVIDERS} filter — which every port had already forgotten,
 * harmlessly today only because `credential` never appears in `social`.
 */
const linkableProviders = (accounts: ReadonlyArray<AuthAccount>, social: ReadonlyArray<string>): ReadonlyArray<string> => {
    const linked = new Set(linkedProviderIds(accounts));

    return social.filter((provider) => !linked.has(provider));
};

const createAccountsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): AccountsController => {
    const resource = createResourceController<AuthAccount>(
        context,
        async (context_) => {
            return { items: assertOk(await context_.authClient.listAccounts()).data ?? [] };
        },
        options,
    );

    return {
        actions: {
            link: async (provider: string) => {
                try {
                    /*
                     * The raw field, not `postAuthDestination`: this runs from a
                     * settings screen on an already-signed-in session. A
                     * `?redirectTo=` in *that* URL was written for whatever sent
                     * the user to settings, so honouring it here would take them
                     * somewhere else the moment they link an account.
                     */
                    assertOk(await context.authClient.linkSocial({ callbackURL: context.redirects.afterSignIn, provider }));
                } catch (error) {
                    notifyError(context, error, context.localization.genericError);
                }
            },
            refetch: resource.refetch,
            unlink: (providerId: string, accountId?: string) =>
                resource.mutate(async () => {
                    if (resource.getState().items.length <= 1) {
                        throw new Error(context.localization.accountsLastOne);
                    }

                    assertOk(await context.authClient.unlinkAccount(accountId === undefined ? { providerId } : { accountId, providerId }));
                }),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { AccountsActions, AccountsController };
export { createAccountsController, linkableProviders, NON_SOCIAL_PROVIDERS };
