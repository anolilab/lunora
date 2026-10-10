//! The fake `celld` and `caddy` (`tests/fakes/`) as a test box installs them:
//! a script per binary whose shebang runs the fake with the record directory,
//! and whose second line is the version it prints. A fleet's environment is
//! cleared by the supervisor, so the record directory travels in the script,
//! never in the environment or `PATH`.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const CELLD_VERSION: &str = "celld 0.6.0";

pub const CADDY_VERSION: &str = "v2.11.6 h1:fake";

/// One recorded run of a fake binary.
#[derive(Clone, Debug)]
pub struct Invocation {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: serde_json::Map<String, Value>,
    pub pid: u64,
}

/// The script that runs fake `program` (`celld` or `caddy`), recording into `records`, printing `version`.
pub fn fake_script(program: &str, records: &Path, version: &str) -> String {
    let fake = match program {
        "celld" => env!("CARGO_BIN_EXE_fake-celld"),
        "caddy" => env!("CARGO_BIN_EXE_fake-caddy"),
        other => panic!("no fake {other}"),
    };

    format!("#!{fake} {}\n{version}\n", records.display())
}

/// Write `contents` to `path` as an executable.
pub fn write_executable(path: &Path, contents: &[u8]) {
    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Paths of the two fakes written into a directory.
pub struct FakeBinaries {
    pub caddy: PathBuf,
    pub celld: PathBuf,
}

/// Write executable fake `celld` and `caddy` into `bin_directory`, recording into `records`.
pub fn write_fake_binaries(bin_directory: &Path, records: &Path) -> FakeBinaries {
    std::fs::create_dir_all(bin_directory).unwrap();
    std::fs::create_dir_all(records).unwrap();

    let (celld, caddy) = (bin_directory.join("celld"), bin_directory.join("caddy"));

    write_executable(&celld, fake_script("celld", records, CELLD_VERSION).as_bytes());
    write_executable(&caddy, fake_script("caddy", records, CADDY_VERSION).as_bytes());

    FakeBinaries { caddy, celld }
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .map(|text| text.lines().filter(|line| !line.is_empty()).filter_map(|line| serde_json::from_str(line).ok()).collect())
        .unwrap_or_default()
}

fn invocations(path: &Path) -> Vec<Invocation> {
    read_json_lines(path)
        .into_iter()
        .map(|line| Invocation {
            argv: line["argv"].as_array().into_iter().flatten().filter_map(|arg| arg.as_str().map(str::to_owned)).collect(),
            cwd: line["cwd"].as_str().unwrap_or_default().to_owned(),
            env: line["env"].as_object().cloned().unwrap_or_default(),
            pid: line["pid"].as_u64().unwrap_or_default(),
        })
        .collect()
}

/// Every recorded run of the fake celld.
pub fn celld_invocations(records: &Path) -> Vec<Invocation> {
    invocations(&records.join("celld.jsonl"))
}

/// Every recorded run of the fake Caddy.
pub fn caddy_invocations(records: &Path) -> Vec<Invocation> {
    invocations(&records.join("caddy.jsonl"))
}

/// Every config the fake Caddy loaded through `POST /load`, oldest first.
pub fn caddy_loads(records: &Path) -> Vec<Value> {
    read_json_lines(&records.join("caddy-loads.jsonl"))
}

/// What makes the fakes misbehave.
#[derive(Clone, Copy)]
pub enum FakeFlag {
    FailDeploy,
    IgnoreSigterm,
    RejectLoad,
}

impl FakeFlag {
    const fn file(self) -> &'static str {
        match self {
            Self::FailDeploy => "fail-deploy",
            Self::IgnoreSigterm => "ignore-sigterm",
            Self::RejectLoad => "reject-load",
        }
    }
}

/// Set a flag the fakes read.
pub fn set_fake_flag(records: &Path, flag: FakeFlag) {
    std::fs::write(records.join(flag.file()), "").unwrap();
}

/// Clear a flag [`set_fake_flag`] set.
pub fn clear_fake_flag(records: &Path, flag: FakeFlag) {
    let _ = std::fs::remove_file(records.join(flag.file()));
}
