import type { ReactElement, ReactNode } from "react";

/** The shell every transcript row shares: a role label, then whatever the row holds. */
const TurnFrame = ({ children, label, testId }: { readonly children: ReactNode; readonly label: string; readonly testId: string }): ReactElement => (
    <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid={testId}>
        <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
        {children}
    </li>
);

export default TurnFrame;
