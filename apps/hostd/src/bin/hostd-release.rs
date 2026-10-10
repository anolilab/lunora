//! `hostd-release`: the release tooling the hostd-release workflow and its
//! maintainers run (plan 458 W7). Never shipped to a box. The release keys it
//! checks signatures against are the ones `build.rs` compiles in, the same set
//! `lunora-hostd` trusts. See `lunora_hostd::release_tools`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use lexopt::Arg::{Long, Value};
use lunora_hostd::release::trusted_keys;
use lunora_hostd::release_tools::{MakeOptions, make_manifest, next_latest_pointer, now, public_key_entries, verify_manifest};

const USAGE: &str = "\
Usage:
  hostd-release manifest --version <version> --base-url <url> [--artifacts-dir <dir>] [--release-id <id>] [--out <file>]
      Make and sign the release manifest from release-pins.json and the built
      lunora-hostd-{platform} and caddy-{platform}.gz in --artifacts-dir
      (default dist/release). The key is HOSTD_RELEASE_SIGNING_KEY, an Ed25519
      PKCS#8 PEM; signing is refused unless it verifies against a pinned key.
  hostd-release verify <manifest.json> [--artifacts-dir <dir>]
      (also: manifest --verify <manifest.json>) Verify a manifest against the
      pinned keys and, with --artifacts-dir, the hostd and Caddy files in it.
  hostd-release public-key <ed25519-key.pem>
      Print the key id and the entries to commit for a private or public key.
  hostd-release latest-pointer --version <version> [--current latest.json] --out latest.json
      Move the hostd-latest pointer forward to a release just published.
";

/// Where `release-pins.json` and `dist/release` are: this crate, `apps/hostd`.
const PACKAGE_DIR: &str = env!("CARGO_MANIFEST_DIR");

fn text(value: OsString) -> Result<String, String> {
    value.into_string().map_err(|_| "arguments must be UTF-8".to_owned())
}

fn value(parser: &mut lexopt::Parser) -> Result<String, String> {
    text(parser.value().map_err(|error| error.to_string())?)
}

fn verify(envelope: &Path, artifacts_dir: Option<&Path>) -> Result<String, String> {
    verify_manifest(envelope, artifacts_dir, trusted_keys()).map(|lines| lines.join("\n"))
}

fn manifest(parser: &mut lexopt::Parser) -> Result<String, String> {
    let mut options = MakeOptions::default();
    let mut verify_path = None;

    while let Some(argument) = parser.next().map_err(|error| error.to_string())? {
        match argument {
            Long("artifacts-dir") => options.artifacts_dir = Some(value(parser)?.into()),
            Long("base-url") => options.base_url = Some(value(parser)?),
            Long("out") => options.out = Some(value(parser)?.into()),
            Long("release-id") => options.release_id = Some(value(parser)?),
            Long("verify") => verify_path = Some(PathBuf::from(value(parser)?)),
            Long("version") => options.version = Some(value(parser)?),
            other => return Err(other.unexpected().to_string()),
        }
    }

    match verify_path {
        Some(envelope) => verify(&envelope, options.artifacts_dir.as_deref()),
        None => {
            let signing_key = std::env::var("HOSTD_RELEASE_SIGNING_KEY").ok();

            make_manifest(&options, Path::new(PACKAGE_DIR), signing_key.as_deref(), trusted_keys(), &now())
        }
    }
}

fn verify_command(parser: &mut lexopt::Parser) -> Result<String, String> {
    let (mut envelope, mut artifacts_dir) = (None, None);

    while let Some(argument) = parser.next().map_err(|error| error.to_string())? {
        match argument {
            Long("artifacts-dir") => artifacts_dir = Some(PathBuf::from(value(parser)?)),
            Value(path) if envelope.is_none() => envelope = Some(PathBuf::from(path)),
            other => return Err(other.unexpected().to_string()),
        }
    }

    let envelope = envelope.ok_or("usage: hostd-release verify <manifest.json> [--artifacts-dir <dir>]")?;

    verify(&envelope, artifacts_dir.as_deref())
}

fn public_key(parser: &mut lexopt::Parser) -> Result<String, String> {
    let usage = "usage: hostd-release public-key <ed25519-key.pem>";
    let path = match parser.next().map_err(|error| error.to_string())? {
        Some(Value(path)) => PathBuf::from(path),
        _ => return Err(usage.into()),
    };

    if parser.next().map_err(|error| error.to_string())?.is_some() {
        return Err(usage.into());
    }

    let pem = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;

    // The entries end with a newline of their own.
    public_key_entries(&pem).map(|entries| entries.trim_end_matches('\n').to_owned())
}

fn latest_pointer(parser: &mut lexopt::Parser) -> Result<String, String> {
    let (mut current, mut out, mut version) = (None, None, None);

    while let Some(argument) = parser.next().map_err(|error| error.to_string())? {
        match argument {
            Long("current") => current = Some(PathBuf::from(value(parser)?)),
            Long("out") => out = Some(PathBuf::from(value(parser)?)),
            Long("version") => version = Some(value(parser)?),
            other => return Err(other.unexpected().to_string()),
        }
    }

    let (Some(version), Some(out)) = (version, out) else {
        return Err("usage: hostd-release latest-pointer --version <version> [--current latest.json] --out latest.json".into());
    };
    // The pointer as published; absent before the first release (or when the download failed).
    let current = match current.filter(|current| current.exists()) {
        Some(path) => {
            let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;

            serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?
        }
        None => serde_json::json!({}),
    };
    let next = next_latest_pointer(&current, &version)?;
    let json = serde_json::to_string(&next).map_err(|error| error.to_string())?;

    std::fs::write(&out, format!("{json}\n")).map_err(|error| format!("{}: {error}", out.display()))?;

    Ok(format!("hostd-latest: stable {}, prerelease {}", next.stable.as_deref().unwrap_or("null"), next.prerelease))
}

fn main() {
    let mut parser = lexopt::Parser::from_env();
    let command = match parser.next() {
        Ok(Some(Value(command))) => command.into_string().unwrap_or_default(),
        Ok(Some(Long("help") | lexopt::Arg::Short('h'))) => {
            print!("{USAGE}");

            return;
        }
        _ => String::new(),
    };
    let outcome = match command.as_str() {
        "manifest" => manifest(&mut parser),
        "verify" => verify_command(&mut parser),
        "public-key" => public_key(&mut parser),
        "latest-pointer" => latest_pointer(&mut parser),
        _ => {
            eprint!("{USAGE}");

            std::process::exit(1);
        }
    };

    match outcome {
        Ok(printed) => println!("{printed}"),
        Err(message) => {
            eprintln!("hostd-release: {message}");

            std::process::exit(1);
        }
    }
}
