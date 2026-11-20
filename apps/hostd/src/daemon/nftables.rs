//! The fleets' egress policy (plan 458 W8, after Noite's tenant sandbox): one
//! nftables table, `inet lunora_hostd`, that `lunora-hostd` installs at start
//! (it holds `CAP_NET_ADMIN` from the systemd unit; no fleet does).
//!
//! Its one chain hooks `output` and looks only at sockets owned by the fleet
//! uid; every other process on the box is untouched. For the fleet uid it
//! accepts, in order:
//!
//! - replies on connections already established (Caddy → fleet);
//! - DNS, to the box's own resolvers only (the `nameserver`s of
//!   `/etc/resolv.conf`, which may be loopback or private): port 53 anywhere
//!   else would reach whatever listens on it, a private resolver or a tunnel;
//! - the bucket endpoint's resolved addresses on its port (which may be private
//!   too: MinIO on the LAN);
//! - the box's own addresses on Caddy's public ports, so an app can call its own
//!   or a sibling's public URL.
//!
//! — all refreshed every 30 s, because a bucket's addresses and the resolvers
//! change. Then it rejects every other address of the box itself (`fib daddr
//! type local`: its public IP reaches whatever listens on `0.0.0.0` through
//! loopback, which no address range catches), loopback, RFC 1918, link-local
//! (with the `169.254.169.254` metadata service), CGNAT `100.64.0.0/10`,
//! `0.0.0.0/8`, the IETF, benchmarking, multicast and reserved ranges, and IPv6
//! loopback, unspecified, ULA, link-local, site-local, multicast, v4-mapped and
//! NAT64 (`64:ff9b::/96` embedding any blocked IPv4 range, and the local-use
//! `64:ff9b:1::/48`). Everything else — the public internet an app calls — is
//! accepted.
//!
//! That blocks a fleet from the celld operator API (every fleet's internal
//! listener is on loopback, siblings' included), from hostd's on-demand-TLS
//! `ask` endpoint and Caddy's admin API (both loopback), from anything else
//! the box serves, on loopback, its own addresses or a private network, and
//! from the cloud metadata service.
//!
//! The table is replaced atomically (`table`; `delete table`; the new table, in
//! one `nft -f` transaction) and left in place when hostd stops: no fleet runs
//! without hostd, and a stale table only ever blocks.
//!
//! nft reads each script from a file, never from stdin (nft 1.0.9 refuses
//! `-f -` unless stdin is a regular file, a FIFO or a character device). The
//! file lives in a fresh 0700 directory under the data directory — written by
//! `lunora-hostd` alone, and among the unit's `ReadWritePaths` — and is deleted
//! once nft has read it.

use std::future::Future;
use std::io::Write;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::BoxFuture;
use super::capabilities::ChildLaunch;
use super::child::{RunOptions, describe_failure, run_child};
use super::config::BucketConfig;
use super::fleet_env::path_only;
use super::log::Logger;

/// The table's family and name.
pub const NFT_TABLE: &str = "lunora_hostd";

/// How often the bucket endpoint is resolved again.
pub const BUCKET_REFRESH: Duration = Duration::from_secs(30);

/// IPv4 ranges a fleet may not reach.
pub const BLOCKED_IPV4: [&str; 11] = [
    "0.0.0.0/8", // "this network": connecting to 0.0.0.0 reaches loopback listeners
    "10.0.0.0/8",
    "100.64.0.0/10", // CGNAT (Alibaba's metadata service is 100.100.100.200)
    "127.0.0.0/8",
    "169.254.0.0/16", // link-local, with the 169.254.169.254 metadata service
    "172.16.0.0/12",
    "192.0.0.0/24", // IETF protocol assignments
    "192.168.0.0/16",
    "198.18.0.0/15", // benchmarking, used inside some provider networks
    "224.0.0.0/4",   // multicast
    "240.0.0.0/4",   // reserved, with the limited broadcast 255.255.255.255
];

/// IPv6 ranges a fleet may not reach, besides the NAT64 forms of [`BLOCKED_IPV4`] ([`blocked_ipv6`]).
pub const BLOCKED_IPV6: [&str; 8] = [
    "::/128",
    "::1/128",
    "::ffff:0:0/96",  // v4-mapped: the IPv4 rules see the packet, but say it twice
    "64:ff9b:1::/48", // local-use NAT64 (RFC 8215): translates into the operator's own network
    "fc00::/7",       // ULA, with AWS's IPv6 metadata service fd00:ec2::254
    "fe80::/10",      // link-local
    "fec0::/10",      // site-local (deprecated, still routed by some stacks)
    "ff00::/8",       // multicast
];

/// Every IPv6 range a fleet may not reach: [`BLOCKED_IPV6`], and each blocked IPv4 range as NAT64 addresses
/// (`64:ff9b::/96`, RFC 6052), which a NAT64 gateway would translate straight into it.
pub fn blocked_ipv6() -> Vec<String> {
    let nat64 = BLOCKED_IPV4.iter().filter_map(|range| {
        let (network, prefix) = range.split_once('/')?;
        let network: Ipv4Addr = network.parse().ok()?;
        let prefix: u32 = prefix.parse().ok()?;
        let embedded = (0x0064_ff9b_u128 << 96) | u128::from(u32::from(network));

        Some(format!("{}/{}", Ipv6Addr::from(embedded), 96 + prefix))
    });

    BLOCKED_IPV6.iter().map(|range| (*range).to_owned()).chain(nat64).collect()
}

/// The resolvers a fleet may send DNS to: the box's own, from `/etc/resolv.conf`.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DnsServers {
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
}

/// The `nameserver` addresses of a `resolv.conf`, a zone (`%eth0`) dropped, literals only, sorted.
pub fn parse_resolv_conf(text: &str) -> DnsServers {
    let mut servers = DnsServers::default();

    for line in text.lines() {
        let mut words = line.split_whitespace();

        if words.next() != Some("nameserver") {
            continue;
        }

        let address = words.next().unwrap_or_default();
        let address = address.split('%').next().unwrap_or_default();

        if address.parse::<Ipv4Addr>().is_ok() {
            servers.ipv4.push(address.to_owned());
        } else if address.parse::<Ipv6Addr>().is_ok() {
            servers.ipv6.push(address.to_owned());
        }
    }

    servers.ipv4.sort();
    servers.ipv4.dedup();
    servers.ipv6.sort();
    servers.ipv6.dedup();

    servers
}

/// Where Debian, Ubuntu (and Arch) install `nft`; an absolute path, never a `PATH` lookup.
const NFT_CANDIDATES: [&str; 3] = ["/usr/sbin/nft", "/sbin/nft", "/usr/bin/nft"];

/// The bucket endpoint's addresses, and the port a fleet reaches it on.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BucketAddresses {
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub port: u16,
}

/// The host and port of the bucket endpoint: the configured one, or AWS S3's regional endpoint.
pub fn bucket_endpoint_of(bucket: &BucketConfig) -> Result<(String, u16), String> {
    let endpoint = bucket.endpoint.clone().unwrap_or_else(|| format!("https://s3.{}.amazonaws.com", bucket.region.as_deref().unwrap_or("us-east-1")));
    let url = url::Url::parse(&endpoint).map_err(|error| format!("the bucket endpoint {endpoint} is not a URL: {error}"))?;
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_prefix('[').and_then(|inner| inner.strip_suffix(']')).unwrap_or(host);

    Ok((host.to_owned(), url.port().unwrap_or(if url.scheme() == "https" { 443 } else { 80 })))
}

fn elements_of(addresses: &[String], port: u16) -> Vec<String> {
    addresses.iter().map(|address| format!("{address} . {port}")).collect()
}

fn set_definition(name: &str, kind: &str, elements: &[String]) -> Vec<String> {
    let mut lines = vec![format!("    set {name} {{"), format!("        type {kind}")];

    if !elements.is_empty() {
        lines.push(format!("        elements = {{ {} }}", elements.join(", ")));
    }

    lines.push("    }".into());

    lines
}

/// Only literal addresses ever reach the ruleset text.
fn checked(bucket: &BucketAddresses) -> BucketAddresses {
    BucketAddresses {
        ipv4: bucket.ipv4.iter().filter(|address| address.parse::<Ipv4Addr>().is_ok()).cloned().collect(),
        ipv6: bucket.ipv6.iter().filter(|address| address.parse::<Ipv6Addr>().is_ok()).cloned().collect(),
        port: bucket.port,
    }
}

fn checked_dns(dns: &DnsServers) -> DnsServers {
    DnsServers {
        ipv4: dns.ipv4.iter().filter(|address| address.parse::<Ipv4Addr>().is_ok()).cloned().collect(),
        ipv6: dns.ipv6.iter().filter(|address| address.parse::<Ipv6Addr>().is_ok()).cloned().collect(),
    }
}

/// What the table lets through besides the public internet: the bucket, the resolvers, Caddy's public ports.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Allowed {
    pub bucket: BucketAddresses,
    pub dns: DnsServers,
}

/// The four sets, as `set` definitions (`ruleset`) or element lists (`update`).
fn sets(allowed: &Allowed) -> [(&'static str, &'static str, Vec<String>); 4] {
    let BucketAddresses { ipv4, ipv6, port } = checked(&allowed.bucket);
    let dns = checked_dns(&allowed.dns);

    [
        ("bucket_v4", "ipv4_addr . inet_service", elements_of(&ipv4, port)),
        ("bucket_v6", "ipv6_addr . inet_service", elements_of(&ipv6, port)),
        ("dns_v4", "ipv4_addr", dns.ipv4),
        ("dns_v6", "ipv6_addr", dns.ipv6),
    ]
}

/// The whole table, as an `nft -f` script that replaces any previous one in a single transaction. `edge_ports` are
/// Caddy's public ports, which a fleet may reach on the box's own addresses.
pub fn nft_ruleset(fleet_uid: u32, allowed: &Allowed, edge_ports: &[u16]) -> String {
    let mut lines = vec![format!("table inet {NFT_TABLE}"), format!("delete table inet {NFT_TABLE}"), format!("table inet {NFT_TABLE} {{")];
    let mut ports: Vec<String> = edge_ports.iter().map(ToString::to_string).collect();

    ports.sort();
    ports.dedup();

    for (name, kind, elements) in sets(allowed) {
        lines.extend(set_definition(name, kind, &elements));
    }

    lines.extend([
        "    chain fleet_egress {".to_owned(),
        "        type filter hook output priority 0; policy accept;".to_owned(),
        format!("        meta skuid != {fleet_uid} return"),
        "        ct state established,related accept".to_owned(),
        "        ip daddr @dns_v4 udp dport 53 accept".to_owned(),
        "        ip daddr @dns_v4 tcp dport 53 accept".to_owned(),
        "        ip6 daddr @dns_v6 udp dport 53 accept".to_owned(),
        "        ip6 daddr @dns_v6 tcp dport 53 accept".to_owned(),
        "        ip daddr . tcp dport @bucket_v4 accept".to_owned(),
        "        ip6 daddr . tcp dport @bucket_v6 accept".to_owned(),
    ]);

    if !ports.is_empty() {
        lines.push(format!("        fib daddr type local tcp dport {{ {} }} accept", ports.join(", ")));
    }

    lines.extend([
        "        fib daddr type local reject".to_owned(),
        format!("        ip daddr {{ {} }} reject", BLOCKED_IPV4.join(", ")),
        format!("        ip6 daddr {{ {} }} reject", blocked_ipv6().join(", ")),
        "    }".to_owned(),
        "}".to_owned(),
        String::new(),
    ]);

    lines.join("\n")
}

/// An `nft -f` script that swaps the sets' elements in one transaction.
pub fn nft_sets_update(allowed: &Allowed) -> String {
    let mut lines = Vec::new();
    let sets = sets(allowed);

    for (name, _, _) in &sets {
        lines.push(format!("flush set inet {NFT_TABLE} {name}"));
    }

    for (name, _, elements) in &sets {
        if !elements.is_empty() {
            lines.push(format!("add element inet {NFT_TABLE} {name} {{ {} }}", elements.join(", ")));
        }
    }

    lines.push(String::new());

    lines.join("\n")
}

/// Run `nft` with `args`. Errs with what nft printed when it fails.
pub async fn run_nft(args: Vec<String>) -> Result<String, String> {
    let nft = NFT_CANDIDATES
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or_else(|| format!("nft is not installed (looked in {})", NFT_CANDIDATES.join(", ")))?;
    let result = run_child(&ChildLaunch::DIRECT, nft, &args, RunOptions::new(path_only(), Duration::from_secs(10))).await?;

    if result.code != Some(0) || result.timed_out {
        return Err(describe_failure(&format!("nft {}", args.join(" ")), &result, 500));
    }

    Ok(result.stdout)
}

/// A fresh 0700 directory `{parent}/.nft-{random}`, as `mkdtemp` makes one.
fn fresh_directory(parent: &Path) -> Result<PathBuf, String> {
    loop {
        let mut suffix = [0_u8; 6];

        getrandom::fill(&mut suffix).map_err(|error| format!("no randomness for a temp directory: {error}"))?;

        let directory = parent.join(format!(".nft-{}", hex::encode(suffix)));

        match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("cannot create {}: {error}", directory.display())),
        }
    }
}

/// [`apply_nft_script`], running nft through `run` (tests replace it).
async fn apply_nft_script_with<F: Future<Output = Result<String, String>>>(
    script: &str,
    work_dir: &Path,
    run: impl FnOnce(Vec<String>) -> F,
) -> Result<(), String> {
    let directory = fresh_directory(work_dir)?;
    let file = directory.join("ruleset.nft");
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .and_then(|mut handle| handle.write_all(script.as_bytes()))
        .map_err(|error| format!("cannot write {}: {error}", file.display()));
    let applied = match written {
        Ok(()) => run(vec!["-f".into(), file.to_string_lossy().into_owned()]).await.map(drop),
        Err(error) => Err(error),
    };

    let _ = std::fs::remove_dir_all(&directory);

    applied
}

/// Apply `script` with `nft -f`, from a file: written, 0600, into a fresh 0700
/// directory under `work_dir` (one only the daemon writes), and removed again
/// whether nft took it or not.
pub async fn apply_nft_script(script: &str, work_dir: &Path) -> Result<(), String> {
    apply_nft_script_with(script, work_dir, run_nft).await
}

type Resolved = (Vec<String>, Vec<String>);

/// What the firewall needs from the system; the real one runs `nft` and resolves with the system resolver.
#[derive(Clone)]
pub struct FirewallSystem {
    /// Apply an `nft -f` script.
    pub apply: Arc<dyn Fn(String) -> BoxFuture<'static, Result<(), String>> + Send + Sync>,
    /// Whether the table is loaded.
    pub present: Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
    /// A host's IPv4 and IPv6 addresses.
    pub resolve: Arc<dyn Fn(String) -> BoxFuture<'static, Result<Resolved, String>> + Send + Sync>,
    /// The box's resolvers, read again at each refresh.
    pub resolvers: Arc<dyn Fn() -> DnsServers + Send + Sync>,
}

impl FirewallSystem {
    /// The real firewall system, writing nft's scripts under `work_dir` (the data directory).
    pub fn real(work_dir: PathBuf) -> Self {
        Self {
            apply: Arc::new(move |script| {
                let work_dir = work_dir.clone();

                Box::pin(async move { apply_nft_script(&script, &work_dir).await })
            }),
            present: Arc::new(|| Box::pin(async { run_nft(vec!["list".into(), "table".into(), "inet".into(), NFT_TABLE.into()]).await.is_ok() })),
            resolve: Arc::new(|host| Box::pin(resolve_host(host))),
            resolvers: Arc::new(|| parse_resolv_conf(&std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default())),
        }
    }
}

/// A literal address resolves to itself; a name through the system resolver.
async fn resolve_host(host: String) -> Result<Resolved, String> {
    if host.parse::<Ipv4Addr>().is_ok() {
        return Ok((vec![host], Vec::new()));
    }

    if host.parse::<Ipv6Addr>().is_ok() {
        return Ok((Vec::new(), vec![host]));
    }

    let addresses = tokio::net::lookup_host((host.as_str(), 0)).await.map_err(|error| error.to_string())?.map(|address| address.ip()).collect::<Vec<_>>();

    Ok((
        addresses.iter().filter(|address| address.is_ipv4()).map(ToString::to_string).collect(),
        addresses.iter().filter(|address| address.is_ipv6()).map(ToString::to_string).collect(),
    ))
}

pub struct EgressFirewallOptions {
    pub bucket: BucketConfig,
    /// Caddy's public ports: a fleet may reach the box's own addresses on these, and on nothing else.
    pub edge_ports: Vec<u16>,
    pub fleet_uid: u32,
    pub logger: Logger,
    pub refresh: Duration,
    pub system: Option<FirewallSystem>,
    /// Where the real system writes nft's scripts: the data directory.
    pub work_dir: PathBuf,
}

struct Inner {
    bucket: BucketConfig,
    current: Mutex<Allowed>,
    fleet_uid: u32,
    logger: Logger,
    system: FirewallSystem,
}

fn sorted((mut ipv4, mut ipv6): Resolved) -> Resolved {
    ipv4.sort();
    ipv6.sort();

    (ipv4, ipv6)
}

impl Inner {
    fn current(&self) -> Allowed {
        self.current.lock().map(|current| current.clone()).unwrap_or_default()
    }

    fn set_current(&self, next: Allowed) {
        if let Ok(mut current) = self.current.lock() {
            *current = next;
        }
    }

    async fn refresh(&self) -> Result<(), String> {
        let (host, port) = bucket_endpoint_of(&self.bucket)?;
        let (ipv4, ipv6) = sorted((self.system.resolve)(host).await?);
        let next = Allowed { bucket: BucketAddresses { ipv4, ipv6, port }, dns: (self.system.resolvers)() };

        if next == self.current() {
            return Ok(());
        }

        (self.system.apply)(nft_sets_update(&next)).await?;
        self.set_current(next);

        Ok(())
    }

    /// The first resolution may fail (DNS not up yet): start with empty sets, the refresh fills them.
    async fn resolve_quietly(&self, host: &str) -> Resolved {
        match (self.system.resolve)(host.to_owned()).await {
            Ok(resolved) => sorted(resolved),
            Err(error) => {
                self.logger.warn(&format!("could not resolve the bucket endpoint {host}: {error}; retrying every 30 s"));

                (Vec::new(), Vec::new())
            }
        }
    }
}

/// The egress table: installed once, its bucket sets kept current.
pub struct EgressFirewall {
    edge_ports: Vec<u16>,
    inner: Arc<Inner>,
    refresh: Duration,
    task: Mutex<Option<tokio::task::AbortHandle>>,
}

impl EgressFirewall {
    pub fn new(options: EgressFirewallOptions) -> Self {
        let system = options.system.unwrap_or_else(|| FirewallSystem::real(options.work_dir));

        Self {
            edge_ports: options.edge_ports,
            inner: Arc::new(Inner {
                bucket: options.bucket,
                current: Mutex::new(Allowed::default()),
                fleet_uid: options.fleet_uid,
                logger: options.logger,
                system,
            }),
            refresh: options.refresh,
            task: Mutex::new(None),
        }
    }

    /// Install the table and check that it is loaded, then refresh the bucket's
    /// addresses every 30 s. Errs when nft refuses the table or it is not there afterwards.
    pub async fn install(&self) -> Result<(), String> {
        let inner = &self.inner;
        let (host, port) = bucket_endpoint_of(&inner.bucket)?;
        let (ipv4, ipv6) = inner.resolve_quietly(&host).await;
        let current = Allowed { bucket: BucketAddresses { ipv4, ipv6, port }, dns: (inner.system.resolvers)() };

        (inner.system.apply)(nft_ruleset(inner.fleet_uid, &current, &self.edge_ports)).await?;
        inner.set_current(current);

        if !(inner.system.present)().await {
            return Err(format!("the nftables table inet {NFT_TABLE} is not loaded after applying it"));
        }

        let refresher = Arc::clone(inner);
        let period = self.refresh;
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);

            loop {
                interval.tick().await;

                if let Err(error) = refresher.refresh().await {
                    refresher.logger.warn(&format!("could not refresh the bucket's addresses in the egress table: {error}"));
                }
            }
        });

        if let Some(previous) = self.task.lock().ok().and_then(|mut slot| slot.replace(task.abort_handle())) {
            previous.abort();
        }

        Ok(())
    }

    /// Resolve the bucket endpoint and read the resolvers again, and swap the sets when either changed.
    pub async fn refresh(&self) -> Result<(), String> {
        self.inner.refresh().await
    }

    /// Stop refreshing. The table stays: a stale one only blocks.
    pub fn stop(&self) {
        if let Some(task) = self.task.lock().ok().and_then(|mut slot| slot.take()) {
            task.abort();
        }
    }
}

impl Drop for EgressFirewall {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn addresses(ipv4: &[&str], ipv6: &[&str], port: u16) -> BucketAddresses {
        BucketAddresses { ipv4: ipv4.iter().map(|&a| a.into()).collect(), ipv6: ipv6.iter().map(|&a| a.into()).collect(), port }
    }

    fn allowed(ipv4: &[&str], ipv6: &[&str], port: u16, dns: &[&str]) -> Allowed {
        Allowed { bucket: addresses(ipv4, ipv6, port), dns: parse_resolv_conf(&dns.iter().map(|server| format!("nameserver {server}\n")).collect::<String>()) }
    }

    #[test]
    fn filters_only_the_fleet_uid() {
        let expected = [
            "table inet lunora_hostd",
            "delete table inet lunora_hostd",
            "table inet lunora_hostd {",
            "    set bucket_v4 {",
            "        type ipv4_addr . inet_service",
            "        elements = { 127.0.0.1 . 19000, 203.0.113.9 . 19000 }",
            "    }",
            "    set bucket_v6 {",
            "        type ipv6_addr . inet_service",
            "        elements = { 2001:db8::9 . 19000 }",
            "    }",
            "    set dns_v4 {",
            "        type ipv4_addr",
            "        elements = { 127.0.0.53 }",
            "    }",
            "    set dns_v6 {",
            "        type ipv6_addr",
            "    }",
            "    chain fleet_egress {",
            "        type filter hook output priority 0; policy accept;",
            "        meta skuid != 990 return",
            "        ct state established,related accept",
            "        ip daddr @dns_v4 udp dport 53 accept",
            "        ip daddr @dns_v4 tcp dport 53 accept",
            "        ip6 daddr @dns_v6 udp dport 53 accept",
            "        ip6 daddr @dns_v6 tcp dport 53 accept",
            "        ip daddr . tcp dport @bucket_v4 accept",
            "        ip6 daddr . tcp dport @bucket_v6 accept",
            "        fib daddr type local tcp dport { 443, 80 } accept",
            "        fib daddr type local reject",
            "        ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } reject",
            "        ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, 64:ff9b:1::/48, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b::/104, 64:ff9b::a00:0/104, 64:ff9b::6440:0/106, 64:ff9b::7f00:0/104, 64:ff9b::a9fe:0/112, 64:ff9b::ac10:0/108, 64:ff9b::c000:0/120, 64:ff9b::c0a8:0/112, 64:ff9b::c612:0/111, 64:ff9b::e000:0/100, 64:ff9b::f000:0/100 } reject",
            "    }",
            "}",
            "",
        ]
        .join("\n");

        assert_eq!(nft_ruleset(990, &allowed(&["127.0.0.1", "203.0.113.9"], &["2001:db8::9"], 19_000, &["127.0.0.53"]), &[80, 443, 80]), expected);
    }

    #[test]
    fn reads_only_literal_nameservers() {
        let servers =
            parse_resolv_conf("# generated\nnameserver 127.0.0.53\noptions edns0\nnameserver fe80::1%eth0\nnameserver resolver.example\nnameserver 10.0.0.2\n");

        assert_eq!(servers, DnsServers { ipv4: vec!["10.0.0.2".into(), "127.0.0.53".into()], ipv6: vec!["fe80::1".into()] });
    }

    fn in_range(address: std::net::IpAddr, range: &str) -> bool {
        let (network, prefix) = range.split_once('/').unwrap();
        let prefix: u32 = prefix.parse().unwrap();

        match (address, network.parse().unwrap()) {
            (std::net::IpAddr::V4(a), std::net::IpAddr::V4(n)) => prefix == 0 || (u32::from(a) ^ u32::from(n)) >> (32 - prefix) == 0,
            (std::net::IpAddr::V6(a), std::net::IpAddr::V6(n)) => prefix == 0 || (u128::from(a) ^ u128::from(n)) >> (128 - prefix) == 0,
            _ => false,
        }
    }

    #[test]
    fn blocks_loopback_private_link_local_cgnat_multicast_and_their_nat64_forms() {
        let ipv6 = blocked_ipv6();
        let blocked = |address: &str, ranges: &[&str]| ranges.iter().any(|range| in_range(address.parse().unwrap(), range));
        let blocked_v6 = |address: &str| ipv6.iter().any(|range| in_range(address.parse().unwrap(), range));
        let v4 = [
            "127.0.0.1",
            "0.0.0.0",
            "10.1.2.3",
            "172.20.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "224.0.0.251",
            "255.255.255.255",
            "198.18.0.1",
            "8.8.8.8",
            "203.0.113.9",
        ];
        let v6 = ["::1", "fd00:ec2::254", "fe80::1", "ff02::1", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b:1::1", "64:ff9b::808:808", "2001:db8::1"];

        assert_eq!(v4.map(|address| blocked(address, &BLOCKED_IPV4)), [true, true, true, true, true, true, true, true, true, true, false, false]);
        assert_eq!(v6.map(blocked_v6), [true, true, true, true, true, true, true, false, false]);
    }

    #[test]
    fn never_writes_anything_but_an_address_into_the_script() {
        let hostile = Allowed {
            bucket: addresses(&["1.2.3.4 . 1 }; flush ruleset; add table x {", "not-an-address"], &["::1; flush ruleset"], 443),
            dns: DnsServers { ipv4: vec!["1.1.1.1; flush ruleset".into()], ipv6: Vec::new() },
        };
        let script = nft_ruleset(990, &hostile, &[443]);

        assert!(!script.contains("flush ruleset"));
        assert!(!script.contains("elements"));
        assert_eq!(
            nft_sets_update(&allowed(&["198.51.100.1", "evil;"], &[], 443, &["10.0.0.2"])),
            "flush set inet lunora_hostd bucket_v4\nflush set inet lunora_hostd bucket_v6\nflush set inet lunora_hostd dns_v4\nflush set inet lunora_hostd dns_v6\nadd element inet lunora_hostd bucket_v4 { 198.51.100.1 . 443 }\nadd element inet lunora_hostd dns_v4 { 10.0.0.2 }\n"
        );
    }

    #[test]
    fn takes_the_bucket_endpoint() {
        let bucket = |endpoint: Option<&str>, region: Option<&str>| BucketConfig {
            endpoint: endpoint.map(Into::into),
            name: "b".into(),
            region: region.map(Into::into),
        };
        let cases = [
            (bucket(None, None), ("s3.us-east-1.amazonaws.com", 443)),
            (bucket(None, Some("eu-west-1")), ("s3.eu-west-1.amazonaws.com", 443)),
            (bucket(Some("http://127.0.0.1:19000"), None), ("127.0.0.1", 19_000)),
            (bucket(Some("https://acc.r2.cloudflarestorage.com"), None), ("acc.r2.cloudflarestorage.com", 443)),
            (bucket(Some("http://[fd00::5]:9000"), None), ("fd00::5", 9000)),
        ];

        for (bucket, (host, port)) in cases {
            assert_eq!(bucket_endpoint_of(&bucket).unwrap(), (host.to_owned(), port));
        }

        assert!(bucket_endpoint_of(&bucket(Some("not a url"), None)).is_err());
    }

    fn fake_firewall(resolved: Arc<Mutex<Resolved>>, present: bool) -> (FirewallSystem, Arc<Mutex<Vec<String>>>) {
        let applied = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&applied);
        let system = FirewallSystem {
            apply: Arc::new(move |script| {
                sink.lock().unwrap().push(script);

                Box::pin(async { Ok(()) })
            }),
            present: Arc::new(move || Box::pin(async move { present })),
            resolve: Arc::new(move |_| {
                let resolved = resolved.lock().unwrap().clone();

                Box::pin(async move { Ok(resolved) })
            }),
            resolvers: Arc::new(|| DnsServers { ipv4: vec!["127.0.0.53".into()], ipv6: Vec::new() }),
        };

        (system, applied)
    }

    fn firewall(endpoint: Option<&str>, system: FirewallSystem) -> EgressFirewall {
        EgressFirewall::new(EgressFirewallOptions {
            bucket: BucketConfig { endpoint: endpoint.map(Into::into), name: "b".into(), region: None },
            edge_ports: vec![80, 443],
            fleet_uid: 990,
            logger: Logger::silent(),
            refresh: BUCKET_REFRESH,
            system: Some(system),
            work_dir: std::env::temp_dir(),
        })
    }

    #[tokio::test]
    async fn swaps_the_bucket_set_only_when_the_addresses_change() {
        let resolved = Arc::new(Mutex::new((vec!["192.0.2.2".to_owned(), "192.0.2.1".to_owned()], Vec::new())));
        let (system, applied) = fake_firewall(Arc::clone(&resolved), true);
        let firewall = firewall(Some("https://store.example:9000"), system);

        firewall.install().await.unwrap();
        firewall.refresh().await.unwrap();

        assert_eq!(applied.lock().unwrap().len(), 1);
        assert!(applied.lock().unwrap()[0].contains("elements = { 192.0.2.1 . 9000, 192.0.2.2 . 9000 }"));

        resolved.lock().unwrap().0 = vec!["192.0.2.3".to_owned()];
        firewall.refresh().await.unwrap();
        firewall.stop();

        assert_eq!(applied.lock().unwrap().len(), 2);
        assert!(applied.lock().unwrap()[1].contains("add element inet lunora_hostd bucket_v4 { 192.0.2.3 . 9000 }"));
    }

    #[tokio::test(start_paused = true)]
    async fn refreshes_every_period_after_install() {
        let resolved = Arc::new(Mutex::new((vec!["192.0.2.1".to_owned()], Vec::new())));
        let (system, applied) = fake_firewall(Arc::clone(&resolved), true);
        let firewall = firewall(None, system);

        firewall.install().await.unwrap();
        resolved.lock().unwrap().0 = vec!["192.0.2.9".to_owned()];
        tokio::time::sleep(BUCKET_REFRESH + Duration::from_secs(1)).await;

        assert_eq!(applied.lock().unwrap().len(), 2);

        firewall.stop();
    }

    #[tokio::test]
    async fn fails_when_the_table_is_not_loaded_afterwards() {
        let (system, _) = fake_firewall(Arc::new(Mutex::new((Vec::new(), Vec::new()))), false);

        assert!(firewall(None, system).install().await.unwrap_err().contains("not loaded"));
    }

    #[tokio::test]
    async fn resolves_a_literal_address_to_itself() {
        assert_eq!(resolve_host("127.0.0.1".into()).await.unwrap(), (vec!["127.0.0.1".to_owned()], Vec::new()));
        assert_eq!(resolve_host("fd00::5".into()).await.unwrap(), (Vec::new(), vec!["fd00::5".to_owned()]));
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn hands_nft_the_script_as_a_private_file_and_deletes_it_afterwards() {
        let root = tempfile::tempdir().unwrap();
        let seen = Mutex::new(Vec::new());

        apply_nft_script_with("table inet lunora_hostd\n", root.path(), |args| {
            let file = PathBuf::from(&args[1]);

            seen.lock().unwrap().push((args.clone(), mode(file.parent().unwrap()), mode(&file), std::fs::read_to_string(&file).unwrap()));

            async { Ok(String::new()) }
        })
        .await
        .unwrap();

        let seen = seen.into_inner().unwrap();
        let (args, directory_mode, file_mode, text) = &seen[0];

        assert_eq!(args[0], "-f");
        assert!(args[1].starts_with(&root.path().join(".nft-").to_string_lossy().into_owned()));
        assert_eq!(text, "table inet lunora_hostd\n");
        assert_eq!((*file_mode, *directory_mode), (0o600, 0o700));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn deletes_the_file_when_nft_refuses_it() {
        let root = tempfile::tempdir().unwrap();
        let error = apply_nft_script_with("bogus\n", root.path(), |_| async { Err("nft -f exited 1: syntax error".to_owned()) }).await.unwrap_err();

        assert!(error.contains("syntax error"));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
