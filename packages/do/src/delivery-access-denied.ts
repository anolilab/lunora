import { LunoraError } from "@lunora/errors";

class DeliveryAccessDenied extends LunoraError {
    public constructor() {
        super("FORBIDDEN", "AccessDenied");
    }
}

const deliveryAccessDenied = (): LunoraError => new DeliveryAccessDenied();
const isDeliveryAccessDenied = (error: unknown): boolean => error instanceof DeliveryAccessDenied;

export { deliveryAccessDenied, isDeliveryAccessDenied };
