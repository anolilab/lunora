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
 * managed by `&lt;PasskeysCard>`.
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

const createAccountsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): AccountsController => {
    const resource = createResourceController<AuthAccount>(context, async (context_) => assertOk(await context_.authClient.listAccounts()).data ?? [], options);

    return {
        actions: {
            link: async (provider: string) => {
                try {
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
export { createAccountsController, linkedProviderIds, NON_SOCIAL_PROVIDERS };
