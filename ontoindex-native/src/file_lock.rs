use napi::{Error, Result};
use napi_derive::napi;
use std::fs::File;

/// A held advisory lock. Closing the handle releases it without removing its file.
#[napi]
pub struct NativeFileLock {
    file: Option<File>,
}

#[napi]
impl NativeFileLock {
    #[napi]
    pub fn release(&mut self) {
        drop(self.file.take());
    }
}

#[cfg(target_os = "linux")]
fn acquire_file_lock(path: &std::path::Path) -> std::io::Result<Option<File>> {
    use std::fs::{self, OpenOptions, TryLockError};
    use std::io::{Error, ErrorKind};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    // The caller owns a trusted directory and must never replace the lock inode.
    // Reject symlinks before opening, then verify the opened file's identity.
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(Error::new(ErrorKind::InvalidInput, "lock path is not a regular file"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    let opened = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if !opened.is_file()
        || !named.is_file()
        || opened.dev() != named.dev()
        || opened.ino() != named.ino()
    {
        return Err(Error::new(ErrorKind::InvalidInput, "lock file identity changed"));
    }
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(not(target_os = "linux"))]
fn acquire_file_lock(_path: &std::path::Path) -> std::io::Result<Option<File>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "native file locks require Linux",
    ))
}

#[napi(js_name = "tryAcquireFileLock")]
pub fn try_acquire_file_lock(path: String) -> Result<Option<NativeFileLock>> {
    acquire_file_lock(std::path::Path::new(&path))
        .map(|file| file.map(|file| NativeFileLock { file: Some(file) }))
        .map_err(|error| Error::from_reason(format!("failed to acquire file lock {path}: {error}")))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{acquire_file_lock, NativeFileLock};
    use std::fs;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    #[test]
    fn contention_release_and_drop_preserve_file() {
        let directory = std::env::temp_dir().join(format!("ontoindex-lock-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("lock");
        let mut held = NativeFileLock { file: acquire_file_lock(&path).unwrap() };
        assert!(held.file.is_some());
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::write(&path, b"retained metadata").unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        assert!(acquire_file_lock(&path).unwrap().is_none());
        held.release();
        held.release();
        let reacquired = acquire_file_lock(&path).unwrap().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"retained metadata");
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        drop(reacquired);
        let dropped = NativeFileLock { file: acquire_file_lock(&path).unwrap() };
        drop(dropped);
        assert!(acquire_file_lock(&path).unwrap().is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn symlinks_and_missing_parents_are_errors() {
        let directory = std::env::temp_dir().join(format!("ontoindex-lock-errors-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let target = directory.join("target");
        fs::write(&target, b"unchanged").unwrap();
        let path = directory.join("link");
        symlink(&target, &path).unwrap();
        assert!(acquire_file_lock(&path).is_err());
        assert!(acquire_file_lock(&directory.join("missing/lock")).is_err());
        assert_eq!(fs::read(target).unwrap(), b"unchanged");
        fs::remove_dir_all(directory).unwrap();
    }
}
