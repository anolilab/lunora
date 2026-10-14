import { networkInterfaces } from "node:os";

/** Reads the host's network interfaces — injectable so the loopback check is unit-testable. */
type NetworkInterfacesReader = typeof networkInterfaces;

/**
 * True when the host exposes an IPv6 loopback (`::1`) — the address `workerd`
 * binds to by default. On hosts without it (many containers / CI images expose
 * only IPv4 `127.0.0.1`), `wrangler dev` aborts on startup with
 * `Cannot assign requested address; addr = [::1]:8787`. `lunora dev` detects the
 * gap and binds the IPv4 loopback (`--ip 127.0.0.1`) instead. The interface
 * lookup is injectable so the decision can be exercised both ways in tests.
 */
const hasIpv6Loopback = (readInterfaces: NetworkInterfacesReader = networkInterfaces): boolean =>
    Object.values(readInterfaces()).some((addresses) => addresses?.some((address) => address.internal && address.address === "::1"));

export type { NetworkInterfacesReader };
export { hasIpv6Loopback };
