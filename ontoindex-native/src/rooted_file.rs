use napi::{Error, Result};
use napi_derive::napi;
use std::fs::File;

/// Pins the root inode until close or garbage collection. Returned file descriptors
/// have independent ownership: the Node caller must close each one exactly once.
#[napi]
pub struct NativeRootedDirectory {
    directory: Option<File>,
}

#[napi]
impl NativeRootedDirectory {
    #[napi]
    pub fn open_regular_file(&self, relative: String) -> Result<i32> {
        let directory = self
            .directory
            .as_ref()
            .ok_or_else(|| Error::from_reason("root is closed"))?;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::{AsRawFd, IntoRawFd};
            linux::open_regular(directory.as_raw_fd(), &relative)
                .map(|file| file.into_raw_fd())
                .map_err(|error| {
                    Error::from_reason(format!("rooted regular file open failed: {error}"))
                })
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::{AsRawFd, IntoRawFd};
            macos::open_regular(directory.as_raw_fd(), &relative)
                .map(|file| file.into_raw_fd())
                .map_err(|error| {
                    Error::from_reason(format!("rooted regular file open failed: {error}"))
                })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (directory, relative);
            Err(Error::from_reason(
                "rooted file opens require Linux or macOS",
            ))
        }
    }

    #[napi]
    pub fn close(&mut self) {
        drop(self.directory.take());
    }
}

#[napi(js_name = "openRootedDirectory")]
pub fn open_rooted_directory(root: String) -> Result<NativeRootedDirectory> {
    #[cfg(target_os = "linux")]
    {
        linux::open_root(&root)
            .map(|directory| NativeRootedDirectory {
                directory: Some(directory),
            })
            .map_err(|error| Error::from_reason(format!("rooted directory open failed: {error}")))
    }
    #[cfg(target_os = "macos")]
    {
        macos::open_root(&root)
            .map(|directory| NativeRootedDirectory {
                directory: Some(directory),
            })
            .map_err(|error| Error::from_reason(format!("rooted directory open failed: {error}")))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = root;
        Err(Error::from_reason(
            "rooted file opens require Linux or macOS",
        ))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{self, ErrorKind};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};

    fn validate_relative(path: &str) -> io::Result<CString> {
        if path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "expected a nonempty normal relative path",
            ));
        }
        CString::new(path).map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))
    }

    fn open_beneath_with(
        directory: RawFd,
        path: &CStr,
        flags: i32,
        syscall: impl FnOnce(RawFd, &CStr, &libc::open_how) -> io::Result<RawFd>,
    ) -> io::Result<File> {
        // open_how contains only integer fields; zero also initializes any future
        // ABI fields and selects mode 0 for these non-creating opens.
        let mut how: libc::open_how = unsafe { std::mem::zeroed() };
        how.flags = flags as u64;
        how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS;
        let fd = syscall(directory, path, &how)?;
        // The successful syscall creates a fresh descriptor. Own it immediately,
        // so metadata failures and all other pre-transfer exits close it.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_beneath(directory: RawFd, path: &CStr, flags: i32) -> io::Result<File> {
        open_beneath_with(directory, path, flags, |directory, path, how| {
            // Both pointers remain valid for the syscall; the kernel receives
            // the exact libc ABI size and returns a fresh descriptor or errno.
            let fd = unsafe {
                libc::syscall(
                    libc::SYS_openat2,
                    directory,
                    path.as_ptr(),
                    how as *const libc::open_how,
                    std::mem::size_of::<libc::open_how>(),
                )
            };
            if fd < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(fd as RawFd)
            }
        })
    }

    pub(super) fn open_root(root: &str) -> io::Result<File> {
        if !root.starts_with('/') {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "root must be absolute",
            ));
        }
        let relative = if root == "/" {
            None
        } else {
            Some(validate_relative(&root[1..])?)
        };
        // '/' has no substitutable ancestor. All remaining root components are
        // resolved by one kernel lookup that rejects every symlink component.
        let fd = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let slash = unsafe { File::from_raw_fd(fd) };
        match relative {
            None => Ok(slash),
            Some(path) => open_beneath(
                slash.as_raw_fd(),
                &path,
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
            ),
        }
    }

    fn regular_file(file: File) -> io::Result<File> {
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "target is not a regular file",
            ));
        }
        Ok(file)
    }

    pub(super) fn open_regular(directory: RawFd, relative: &str) -> io::Result<File> {
        let path = validate_relative(relative)?;
        let file = open_beneath(
            directory,
            &path,
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )?;
        regular_file(file)
    }

    #[cfg(test)]
    #[test]
    fn rooted_file_invalid_relative_paths() {
        for path in [
            "",
            "/etc/passwd",
            "../outside",
            "a/../b",
            ".",
            "a/./b",
            "a//b",
            "a/",
            "a\0b",
        ] {
            assert!(validate_relative(path).is_err(), "{path:?}");
        }
        assert!(validate_relative("a/b").is_ok());
    }

    #[cfg(test)]
    #[test]
    fn rooted_file_syscall_errors_fail_closed() {
        for errno in [
            libc::ENOSYS,
            libc::EINVAL,
            libc::EPERM,
            libc::EAGAIN,
            libc::EXDEV,
            libc::ELOOP,
        ] {
            let error = open_beneath_with(
                42,
                c"a/b",
                libc::O_RDONLY | libc::O_CLOEXEC,
                |directory, path, how| {
                    assert_eq!(directory, 42);
                    assert_eq!(path, c"a/b");
                    assert_eq!(
                        how.resolve,
                        libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS
                    );
                    assert_eq!(how.mode, 0);
                    Err(io::Error::from_raw_os_error(errno))
                },
            )
            .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(errno));
        }
    }

    #[cfg(test)]
    #[test]
    fn rooted_file_descriptor_cleanup_and_transfer() {
        use std::os::fd::IntoRawFd;
        let directory = open_root("/").unwrap();
        let fd = directory.as_raw_fd();
        assert!(regular_file(directory).is_err());
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        let mut root = crate::rooted_file::NativeRootedDirectory {
            directory: Some(open_root("/").unwrap()),
        };
        let root_fd = root.directory.as_ref().unwrap().as_raw_fd();
        root.close();
        root.close();
        assert_eq!(unsafe { libc::fcntl(root_fd, libc::F_GETFD) }, -1);
        assert!(root.open_regular_file("etc/passwd".to_string()).is_err());
        let file = File::open("/dev/null").unwrap();
        let transferred = file.into_raw_fd();
        assert!(unsafe { libc::fcntl(transferred, libc::F_GETFD) } >= 0);
        drop(unsafe { File::from_raw_fd(transferred) });
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{self, ErrorKind};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};

    fn validate_relative(path: &str) -> io::Result<()> {
        if path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "expected a nonempty normal relative path",
            ));
        }
        CString::new(path)
            .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
        Ok(())
    }

    fn open_at(directory: RawFd, path: &CStr, flags: libc::c_int) -> io::Result<File> {
        let fd = unsafe { libc::openat(directory, path.as_ptr(), flags) };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            // Take ownership immediately so metadata checks and error exits close it.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    fn open_directory(directory: RawFd, name: &CStr) -> io::Result<File> {
        open_at(
            directory,
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    }

    fn open_slash() -> io::Result<File> {
        let fd = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    pub(super) fn open_root(root: &str) -> io::Result<File> {
        let relative = root
            .strip_prefix('/')
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "root must be absolute"))?;
        if relative.is_empty() {
            return open_slash();
        }
        validate_relative(relative)?;

        // Walk from '/' using a pinned directory descriptor at each component.
        // O_NOFOLLOW rejects symlink ancestors even if they are swapped concurrently.
        let mut directory = open_slash()?;
        for component in relative.split('/') {
            let name = CString::new(component)
                .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
            directory = open_directory(directory.as_raw_fd(), &name)?;
        }
        Ok(directory)
    }

    fn regular_file(file: File) -> io::Result<File> {
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "target is not a regular file",
            ));
        }
        Ok(file)
    }

    pub(super) fn open_regular(directory: RawFd, relative: &str) -> io::Result<File> {
        validate_relative(relative)?;
        let mut components = relative.split('/').peekable();
        let mut parent = None;

        while let Some(component) = components.next() {
            let parent_fd = parent
                .as_ref()
                .map(|opened: &File| opened.as_raw_fd())
                .unwrap_or(directory);
            let name = CString::new(component)
                .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
            if components.peek().is_some() {
                parent = Some(open_directory(parent_fd, &name)?);
            } else {
                let file = open_at(
                    parent_fd,
                    &name,
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )?;
                return regular_file(file);
            }
        }

        unreachable!("validated relative path has a final component")
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::macos;
    use std::fs;
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rooted_file_open_is_anchored_and_rejects_symlinks() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temporary = std::env::temp_dir().join(format!("ontoindex-rooted-macos-{suffix}"));
        let root_path = temporary.join("root");
        let outside = temporary.join("outside");
        fs::create_dir_all(root_path.join("nested")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root_path.join("nested/file"), "inside").unwrap();
        fs::write(outside.join("file"), "outside").unwrap();
        symlink(&outside, root_path.join("directory-link")).unwrap();
        symlink(outside.join("file"), root_path.join("file-link")).unwrap();

        let canonical_root = fs::canonicalize(&root_path).unwrap();
        let root = macos::open_root(canonical_root.to_str().unwrap()).unwrap();
        let mut file = macos::open_regular(root.as_raw_fd(), "nested/file").unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "inside");

        for relative in [
            "",
            "/etc/passwd",
            "../outside/file",
            "nested/../file",
            "nested//file",
            "directory-link/file",
            "file-link",
        ] {
            assert!(
                macos::open_regular(root.as_raw_fd(), relative).is_err(),
                "{relative:?}"
            );
        }

        let root_link = temporary.join("root-link");
        symlink(&canonical_root, &root_link).unwrap();
        assert!(macos::open_root(root_link.to_str().unwrap()).is_err());

        let moved_root = temporary.join("moved-root");
        fs::rename(&root_path, &moved_root).unwrap();
        symlink(&outside, &root_path).unwrap();
        let mut pinned = macos::open_regular(root.as_raw_fd(), "nested/file").unwrap();
        let mut pinned_contents = String::new();
        pinned.read_to_string(&mut pinned_contents).unwrap();
        assert_eq!(pinned_contents, "inside");

        drop((file, pinned, root));
        fs::remove_dir_all(temporary).unwrap();
    }
}
