import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface ActivitySectionProps {
    organizationId: OrgId;
}

/**
 * Activity tab (§3). The org's audit log: who did what, newest first. Every
 * admin-proxy call and other sensitive flow appends an `auditLog` entry, and
 * this is the read view over them. Tenant request and console logs stream
 * separately via Cloudflare Tail/Logpush and the per-deployment admin RPC.
 */
export const ActivitySection = ({ organizationId }: ActivitySectionProps): ReactElement => {
    const entries = useQuery(api.audit_log.list, { organizationId });

    return (
        <section className="card">
            <h3>Activity</h3>
            <AsyncList
                empty="No activity yet."
                render={(rows) => (
                    <table className="table">
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Actor</th>
                                <th>Action</th>
                                <th>Target</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((entry) => (
                                <tr key={entry._id}>
                                    <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                                    <td>{entry.actorUserId}</td>
                                    <td>
                                        <span className="badge">{entry.action}</span>
                                    </td>
                                    <td>{entry.target ?? <span className="muted">—</span>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                rows={entries}
            />
        </section>
    );
};
