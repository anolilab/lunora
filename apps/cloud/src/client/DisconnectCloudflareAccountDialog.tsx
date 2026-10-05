import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { api } from "../../lunora/_generated/api.js";
import type { CloudflareAccountView } from "./cloudflare-accounts";
import { FormError } from "./section-ui";
import type { OrgId } from "./types";

interface DisconnectCloudflareAccountDialogProps {
    account: CloudflareAccountView | null;
    onClose: () => void;
    organizationId: OrgId;
}

/**
 * Confirm a disconnect (`cloudflareAccounts.disconnect`), saying what it does
 * and does not do. The server refuses while a project still deploys into the
 * account; its message is shown as is. Open while `account` is set.
 */
export const DisconnectCloudflareAccountDialog = ({ account, onClose, organizationId }: DisconnectCloudflareAccountDialogProps): ReactElement => {
    const disconnect = useMutation(api.cloudflare_accounts.disconnect);
    const [error, setError] = useState<null | string>(null);

    const close = (): void => {
        setError(null);
        onClose();
    };

    return (
        <Dialog
            onOpenChange={(next) => {
                if (!next) {
                    close();
                }
            }}
            open={account !== null}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Disconnect {account?.label ?? "account"}?</DialogTitle>
                    <DialogDescription>Lunora Cloud deletes its copy of the token.</DialogDescription>
                </DialogHeader>
                <ul className="m-0 grid list-disc gap-1.5 pl-5 text-sm">
                    <li>Refused while a project deploys into this account: move those projects to another target first.</li>
                    <li>Nothing in the account is deleted; the Workers and data there stay yours.</li>
                    <li>The token itself stays valid until you revoke it in your Cloudflare dashboard.</li>
                </ul>
                <FormError message={error} />
                <DialogFooter>
                    <Button onClick={close} type="button" variant="ghost">
                        Cancel
                    </Button>
                    <Button
                        disabled={disconnect.pending || account === null}
                        onClick={() => {
                            if (account === null) {
                                return;
                            }

                            setError(null);
                            void disconnect
                                .mutate({ id: account._id, organizationId })
                                .then(() => {
                                    close();

                                    return undefined;
                                })
                                .catch((error_: unknown) => {
                                    setError(error_ instanceof Error ? error_.message : "disconnect failed");
                                });
                        }}
                        type="button"
                        variant="destructive"
                    >
                        {disconnect.pending ? "Disconnecting…" : "Disconnect"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
