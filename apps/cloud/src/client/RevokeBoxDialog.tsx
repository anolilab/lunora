import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { BoxView } from "./boxes";
import { FormError } from "./section-ui";
import type { OrgId } from "./types";

/** Deadline for the revoke route; a hung route must not leave the dialog spinning. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Revoke through `POST /v1/boxes/revoke` rather than the bare `boxes.revoke`
 * mutation: only the edge can also close the box's session and remove its DNS
 * records. Resolves to a follow-up notice (a DNS record left behind), or `null`.
 */
const requestRevoke = async (id: string, organizationId: OrgId): Promise<null | string> => {
    // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- `response.ok` IS checked, just after the body is read: reading first is what lets the server's own error message surface instead of a bare status code.
    const response = await fetch("/v1/boxes/revoke", {
        body: JSON.stringify({ id, organizationId }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as { dnsError?: string; error?: string } | null;

    if (!response.ok) {
        throw new Error(payload?.error ?? `revoke failed (${String(response.status)})`);
    }

    return payload?.dnsError ? `Revoked, but its DNS records were not removed: ${payload.dnsError}` : null;
};

interface RevokeBoxDialogProps {
    box: BoxView | null;
    onClose: () => void;
    /** Receives a notice worth keeping on the page after the dialog closes. */
    onNotice: (notice: string) => void;
    organizationId: OrgId;
}

/**
 * Confirm a revoke, saying exactly what it does — it cannot be undone, and the
 * row stays (revoked) so its history survives. Open while `box` is set.
 */
export const RevokeBoxDialog = ({ box, onClose, onNotice, organizationId }: RevokeBoxDialogProps): ReactElement => {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);

    return (
        <Dialog
            onOpenChange={(next) => {
                if (!next) {
                    setError(null);
                    onClose();
                }
            }}
            open={box !== null}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Revoke {box?.name ?? "box"}?</DialogTitle>
                    <DialogDescription>This cannot be undone.</DialogDescription>
                </DialogHeader>
                <ul className="m-0 grid list-disc gap-1.5 pl-5 text-sm">
                    <li>Its session with Lunora Cloud is cut at once, and it takes no more deploys.</li>
                    <li>Its hostnames are removed from DNS, so apps on it stop being reachable at their default addresses.</li>
                    <li>It can never enrol again as this box. To use the machine again, enrol it as a new box.</li>
                    <li>Nothing on the machine or in your bucket is deleted; that data stays yours.</li>
                </ul>
                <FormError message={error} />
                <DialogFooter>
                    <Button
                        onClick={() => {
                            setError(null);
                            onClose();
                        }}
                        type="button"
                        variant="ghost"
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={pending || box === null}
                        onClick={() => {
                            if (box === null) {
                                return;
                            }

                            setError(null);
                            setPending(true);

                            void (async () => {
                                try {
                                    const notice = await requestRevoke(box._id, organizationId);

                                    if (notice !== null) {
                                        onNotice(notice);
                                    }

                                    setPending(false);
                                    onClose();
                                } catch (error_: unknown) {
                                    setPending(false);
                                    setError(error_ instanceof Error ? error_.message : "revoke failed");
                                }
                            })();
                        }}
                        type="button"
                        variant="destructive"
                    >
                        {pending ? "Revoking…" : "Revoke box"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
