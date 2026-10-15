//! The fleets' directories on the box (plan 458 W8): what the fleet user may
//! reach in the data directory, and each fleet's own working directory.
//!
//! The data directory, `fleets/` and `releases/` are `{daemon}:{fleet group}`
//! 0710 — the fleet user passes through to its own working directory and to the
//! release it deploys, and lists neither. A release is shared with the fleet
//! group read-only; a fleet's working directory (its `HOME` and `TMPDIR`) is the
//! fleet user's own, 0700.

use std::fs;
use std::os::unix::fs::{PermissionsExt, chown, lchown};
use std::path::Path;
use std::time::Duration;

use super::accounts::Account;
use super::capabilities::ChildLaunch;
use super::child::{RunOptions, describe_failure, run_child};
use super::config::create_dir_all_with_mode;
use super::fleet_env::path_only;

/// How long emptying a fleet's directory may take.
const REMOVE_TIMEOUT: Duration = Duration::from_secs(120);

/// Give the fleet group passage through the data directory: `data_dir`,
/// `fleets/` and `releases/` become `{owner}:{fleet group}` 0710 — the fleet
/// user can reach its own working directory and the release it deploys, and
/// list neither.
pub fn prepare_data_directory(data_dir: &str, account: &Account) -> std::io::Result<()> {
    let data_dir = Path::new(data_dir);

    for path in [data_dir.to_path_buf(), data_dir.join("fleets"), data_dir.join("releases")] {
        create_dir_all_with_mode(&path, 0o710)?;
        chown(&path, None, Some(account.gid))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o710))?;
    }

    Ok(())
}

/// Make a release directory readable to the fleet group (`celld deploy` runs as the fleet user): dirs 0750, files
/// 0640. Links are left alone.
pub fn share_with_fleet(dir: &Path, account: &Account) -> std::io::Result<()> {
    chown(dir, None, Some(account.gid))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o750))?;

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;

        if kind.is_dir() {
            share_with_fleet(&entry.path(), account)?;
        } else if kind.is_file() {
            lchown(entry.path(), None, Some(account.gid))?;
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o640))?;
        }
    }

    Ok(())
}

/// A fleet's working directory (`{data_dir}/fleets/{alias}`), created when
/// missing: the fleet user's own, mode 0700, when fleets run as one. Returns its path.
pub fn ensure_fleet_directory(data_dir: &str, alias: &str, account: Option<&Account>) -> std::io::Result<String> {
    let directory = Path::new(data_dir).join("fleets").join(alias);

    if !directory.exists() {
        create_dir_all_with_mode(&directory, 0o700)?;

        if let Some(account) = account {
            chown(&directory, Some(account.uid), Some(account.gid))?;
        }
    }

    Ok(directory.to_string_lossy().into_owned())
}

/// Delete a fleet's working directory. A fleet user's directory is emptied as
/// that user — the daemon may neither list nor enter it (0700, and the unit
/// grants no `CAP_DAC_*`) — and the empty directory is then removed by the
/// daemon, which owns `fleets/`: `rmdir` needs only `fleets/`, where a
/// recursive removal would have to read the directory and fail with `EACCES`.
/// Errs when the fleet user's `find` fails, or the directory is not empty after it.
pub async fn remove_fleet_directory(data_dir: &str, alias: &str, launch: &ChildLaunch, account: Option<&Account>) -> Result<(), String> {
    let directory = Path::new(data_dir).join("fleets").join(alias);
    let shown = directory.to_string_lossy().into_owned();

    if account.is_none() {
        return match fs::remove_dir_all(&directory) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot remove {shown}: {error}")),
            _ => Ok(()),
        };
    }

    if !directory.exists() {
        return Ok(());
    }

    let args = [shown.clone(), "-mindepth".into(), "1".into(), "-delete".into()];
    let result = run_child(launch, "find", &args, RunOptions::new(path_only(), REMOVE_TIMEOUT)).await?;

    if result.code != Some(0) || result.timed_out {
        return Err(describe_failure("find", &result, 300));
    }

    fs::remove_dir(&directory).map_err(|error| format!("cannot remove {shown}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Account {
        // SAFETY: getuid and getgid cannot fail.
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };

        Account { gid, uid, user: "lunora-fleet".into() }
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn shares_a_release_with_the_fleet_group_and_keeps_the_working_directory_private() {
        let root = tempfile::tempdir().unwrap();
        let release = root.path().join("releases").join("dep_1");
        let data_dir = root.path().to_str().unwrap();

        fs::create_dir_all(release.join("assets")).unwrap();
        fs::write(release.join("wrangler.json"), "{}").unwrap();
        fs::write(release.join("assets").join("a.css"), "").unwrap();
        share_with_fleet(&release, &me()).unwrap();

        assert_eq!(mode(&release.join("assets")), 0o750);
        assert_eq!(mode(&release.join("wrangler.json")), 0o640);

        let directory = ensure_fleet_directory(data_dir, "my-app", Some(&me())).unwrap();

        assert_eq!(Path::new(&directory), root.path().join("fleets").join("my-app"));
        assert_eq!(mode(Path::new(&directory)), 0o700);

        prepare_data_directory(data_dir, &me()).unwrap();

        assert_eq!([mode(root.path()), mode(&root.path().join("fleets")), mode(&root.path().join("releases"))], [0o710; 3]);
    }

    #[tokio::test]
    async fn removes_a_fleet_directory_by_emptying_it_then_rmdir_ing_it() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().to_str().unwrap();
        let directory = ensure_fleet_directory(data_dir, "my-app", Some(&me())).unwrap();

        fs::create_dir_all(Path::new(&directory).join("data").join("nested")).unwrap();
        fs::write(Path::new(&directory).join("data").join("nested").join("db.sqlite"), "").unwrap();
        remove_fleet_directory(data_dir, "my-app", &ChildLaunch::DIRECT, Some(&me())).await.unwrap();

        assert!(!Path::new(&directory).exists());

        remove_fleet_directory(data_dir, "my-app", &ChildLaunch::DIRECT, Some(&me())).await.unwrap();
        remove_fleet_directory(data_dir, "my-app", &ChildLaunch::DIRECT, None).await.unwrap();

        assert_eq!(fs::read_dir(root.path().join("fleets")).unwrap().count(), 0);
    }
}
