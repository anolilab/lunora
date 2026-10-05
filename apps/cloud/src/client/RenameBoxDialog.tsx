import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import type { BoxView } from "./boxes";
import { Field, FieldForm, FormError } from "./section-ui";
import type { OrgId } from "./types";

interface RenameBoxDialogProps {
    box: BoxView;
    onClose: () => void;
    organizationId: OrgId;
}

/**
 * Rename a box (`boxes.rename`). Only the label changes — the slug, and with it
 * every hostname, stays. Mounted per box while open, so the field starts from
 * that box's current name.
 */
export const RenameBoxDialog = ({ box, onClose, organizationId }: RenameBoxDialogProps): ReactElement => {
    const rename = useMutation(api.boxes.rename);
    const [name, setName] = useState(box.name);
    const [error, setError] = useState<null | string>(null);

    return (
        <Dialog
            onOpenChange={(next) => {
                if (!next) {
                    onClose();
                }
            }}
            open
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Rename box</DialogTitle>
                    <DialogDescription>Its hostnames do not change.</DialogDescription>
                </DialogHeader>
                <FieldForm
                    action={() => {
                        setError(null);

                        void (async () => {
                            try {
                                await rename.mutate({ id: box._id, name, organizationId });
                                onClose();
                            } catch (error_: unknown) {
                                setError(error_ instanceof Error ? error_.message : "rename failed");
                            }
                        })();
                    }}
                    className="max-w-none"
                >
                    <Field htmlFor="box-rename" label="Name">
                        <Input
                            autoComplete="off"
                            id="box-rename"
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                            required
                            value={name}
                        />
                    </Field>
                    <Button className="justify-self-start" disabled={rename.pending || name.trim() === ""} type="submit">
                        {rename.pending ? "Saving…" : "Save"}
                    </Button>
                    <FormError message={error} />
                </FieldForm>
            </DialogContent>
        </Dialog>
    );
};
