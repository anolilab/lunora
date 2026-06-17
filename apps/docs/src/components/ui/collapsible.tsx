import { Collapsible as CollapsiblePrimitive } from "radix-ui";

const Collapsible = ({ ...properties }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) => (
    <CollapsiblePrimitive.Root data-slot="collapsible" {...properties} />
);

const CollapsibleTrigger = ({ ...properties }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) => (
    <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...properties} />
);

const CollapsibleContent = ({ ...properties }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) => (
    <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...properties} />
);

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
