//! Following Caddy's access log (plan 458 W6): the lines appended since the
//! last read, across Caddy's own rotation.

use std::fs;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

/// Bytes of access log read per poll; the rest is read on the next one.
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

/// Reads the lines appended to a file since the last read, following a rotation or truncation.
pub struct LogTailer {
    inode: Option<u64>,
    offset: u64,
    /// Bytes after the last newline, so a line (or a character) split across reads is read whole.
    partial: Vec<u8>,
    path: PathBuf,
}

impl LogTailer {
    /// Start following `path`: from its current end when it exists — history
    /// from before the daemon started is not recounted — and from its start
    /// once it appears when it does not.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        // Not written yet: read it whole when it appears.
        let (inode, offset) = fs::symlink_metadata(&path).map_or((None, 0), |stats| (Some(stats.ino()), stats.size()));

        Self { inode, offset, partial: Vec::new(), path }
    }

    /// The complete lines appended since the last call.
    pub fn read(&mut self) -> Vec<String> {
        let Ok(stats) = fs::symlink_metadata(&self.path) else {
            return Vec::new();
        };

        if self.inode.is_none() {
            self.inode = Some(stats.ino());
        } else if self.inode != Some(stats.ino()) || stats.size() < self.offset {
            // Rotated or truncated: the new file is read from its start.
            self.inode = Some(stats.ino());
            self.offset = 0;
            self.partial.clear();
        }

        let length = stats.size().saturating_sub(self.offset).min(MAX_READ_BYTES);

        if length == 0 {
            return Vec::new();
        }

        // Never through a link: the log's directory belongs to Caddy's user, which could plant one.
        let Ok(file) = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&self.path) else {
            return Vec::new();
        };
        let mut buffer = vec![0; usize::try_from(length).unwrap_or_default()];
        let mut filled = 0;

        while filled < buffer.len() {
            match file.read_at(&mut buffer[filled..], self.offset + filled as u64) {
                Ok(0) | Err(_) => break,
                Ok(read) => filled += read,
            }
        }

        buffer.truncate(filled);
        self.offset += filled as u64;
        self.partial.extend_from_slice(&buffer);

        let Some(end) = self.partial.iter().rposition(|byte| *byte == b'\n') else {
            return Vec::new();
        };
        let complete: Vec<u8> = self.partial.drain(..=end).collect();

        complete.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()).map(|line| String::from_utf8_lossy(line).into_owned()).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn append(path: &std::path::Path, text: &str) {
        fs::OpenOptions::new().append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn reads_appended_lines_across_partial_writes_and_rotation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("access.log");

        fs::write(&path, "old-1\nold-2\n").unwrap();

        let mut tailer = LogTailer::new(&path);

        assert_eq!(tailer.read(), Vec::<String>::new());

        append(&path, "new-1\nnew-");
        assert_eq!(tailer.read(), ["new-1"]);

        append(&path, "2\n");
        assert_eq!(tailer.read(), ["new-2"]);

        fs::rename(&path, directory.path().join("access-1.log")).unwrap();
        fs::write(&path, "rotated-1\n").unwrap();
        assert_eq!(tailer.read(), ["rotated-1"]);

        fs::write(&path, "").unwrap();
        append(&path, "cut\n");
        assert_eq!(tailer.read(), ["cut"]);
    }

    #[test]
    fn reads_a_log_that_did_not_exist_yet_from_its_first_line() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("late.log");
        let mut tailer = LogTailer::new(&path);

        assert_eq!(tailer.read(), Vec::<String>::new());

        fs::write(&path, "first\nsecond\n").unwrap();
        assert_eq!(tailer.read(), ["first", "second"]);
    }

    #[test]
    fn never_reads_through_a_link() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("access.log");
        let mut tailer = LogTailer::new(&path);

        fs::write(directory.path().join("secret"), "key\n").unwrap();
        std::os::unix::fs::symlink(directory.path().join("secret"), &path).unwrap();

        assert_eq!(tailer.read(), Vec::<String>::new());
    }
}
