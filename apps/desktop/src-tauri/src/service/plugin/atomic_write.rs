use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

/// 原子替换 patch 层：拒绝覆盖符号链接（patch 会被用户手写，链接等于绕过范围校验）。
pub(super) fn write_patch_layer_atomically(path: &Path, rendered: &str) -> io::Result<()> {
    write_file_atomically(path, rendered)
}

/// 经同目录临时文件原子替换 UTF-8 文件；失败时保留原文件。
pub(super) fn write_file_atomically(path: &Path, rendered: &str) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "refusing to replace a symlink patch layer",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let original = match File::options().read(true).write(true).open(path) {
        Ok(file) => Some(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "patch layer has no parent"))?;
    let mut temp = create_temp(parent, original.as_ref().map(|_| path))?;
    #[cfg(unix)]
    if let Some(original) = &original {
        preserve_permissions(original, temp.as_file())?;
    }
    temp.write_all(rendered.as_bytes())?;
    temp.as_file().sync_all()?;
    if original.is_none() {
        temp.persist_noclobber(path).map_err(|error| error.error)?;
        return Ok(());
    }
    #[cfg(not(windows))]
    temp.persist(path).map_err(|error| error.error)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

        let (file, temp) = temp.into_parts();
        drop(file);
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        let target = wide(path);
        let source = wide(&temp);
        if unsafe {
            ReplaceFileW(
                target.as_ptr(),
                source.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn create_temp(parent: &Path, original: Option<&Path>) -> io::Result<tempfile::NamedTempFile> {
    #[cfg(target_os = "macos")]
    reject_inheritable_parent_acl(parent)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".cordis.patch-");
    #[cfg(windows)]
    if let Some(original) = original {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Security::{
            SetSecurityDescriptorControl, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        let mut descriptor = security_descriptor(original)?;
        if unsafe {
            SetSecurityDescriptorControl(
                descriptor.as_mut_ptr().cast(),
                SE_DACL_PROTECTED,
                SE_DACL_PROTECTED,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.as_mut_ptr().cast(),
            bInheritHandle: 0,
        };
        return builder.make_in(parent, |path| {
            let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    &security,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(unsafe { File::from_raw_handle(handle) })
        });
    }
    #[cfg(not(windows))]
    let _ = original;
    builder.tempfile_in(parent)
}

#[cfg(target_os = "macos")]
fn reject_inheritable_parent_acl(parent: &Path) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    const ACL_TYPE_EXTENDED: libc::c_int = 0x100;
    const ACL_FIRST_ENTRY: libc::c_int = 0;
    const ACL_NEXT_ENTRY: libc::c_int = 1;
    const ACL_ENTRY_FILE_INHERIT: libc::c_int = 1 << 5;

    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_get_entry(
            acl: *mut libc::c_void,
            entry_id: libc::c_int,
            entry: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_get_flagset_np(
            entry: *mut libc::c_void,
            flagset: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_get_flag_np(flagset: *mut libc::c_void, flag: libc::c_int) -> libc::c_int;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }
    let parent = File::open(parent)?;
    let acl = unsafe { acl_get_fd_np(parent.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOENT) | Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP) => Ok(()),
            _ => Err(error),
        };
    }
    let mut entry_id = ACL_FIRST_ENTRY;
    loop {
        let mut entry = std::ptr::null_mut();
        if unsafe { acl_get_entry(acl, entry_id, &mut entry) } != 0 {
            let error = io::Error::last_os_error();
            unsafe { acl_free(acl) };
            return if error.raw_os_error() == Some(libc::EINVAL) {
                Ok(())
            } else {
                Err(error)
            };
        }
        let mut flagset = std::ptr::null_mut();
        if unsafe { acl_get_flagset_np(entry, &mut flagset) } != 0 {
            let error = io::Error::last_os_error();
            unsafe { acl_free(acl) };
            return Err(error);
        }
        let inheritable = unsafe { acl_get_flag_np(flagset, ACL_ENTRY_FILE_INHERIT) };
        if inheritable < 0 {
            let error = io::Error::last_os_error();
            unsafe { acl_free(acl) };
            return Err(error);
        }
        if inheritable > 0 {
            unsafe { acl_free(acl) };
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to stage a patch in a directory with an inheritable extended ACL",
            ));
        }
        entry_id = ACL_NEXT_ENTRY;
    }
}

#[cfg(windows)]
fn security_descriptor(path: &Path) -> io::Result<Vec<u32>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{
        GetFileSecurityW, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    };

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let info = DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION;
    let mut needed = 0;
    unsafe { GetFileSecurityW(path.as_ptr(), info, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
    if unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            info,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(descriptor)
}

#[cfg(unix)]
fn preserve_permissions(original: &File, replacement: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let before = original.metadata()?;
    let after = replacement.metadata()?;
    if (before.uid(), before.gid()) != (after.uid(), after.gid())
        && unsafe { libc::fchown(replacement.as_raw_fd(), before.uid(), before.gid()) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    #[cfg(target_os = "linux")]
    {
        let acl = read_acl(original)?;
        let result = match &acl {
            Some(bytes) => unsafe {
                libc::fsetxattr(
                    replacement.as_raw_fd(),
                    c"system.posix_acl_access".as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            },
            None => unsafe {
                libc::fremovexattr(replacement.as_raw_fd(), c"system.posix_acl_access".as_ptr())
            },
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if acl.is_some()
                || !matches!(
                    error.raw_os_error(),
                    Some(libc::ENODATA) | Some(libc::ENOTSUP)
                )
            {
                return Err(error);
            }
        }
        replacement.set_permissions(before.permissions())?;
        if read_acl(replacement)? != acl {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "patch ACL could not be preserved",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    if unsafe {
        libc::fcopyfile(
            original.as_raw_fd(),
            replacement.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_SECURITY,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let after = replacement.metadata()?;
    if (before.uid(), before.gid(), before.mode()) != (after.uid(), after.gid(), after.mode()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "patch ownership or mode could not be preserved",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_acl(file: &File) -> io::Result<Option<Vec<u8>>> {
    use std::os::fd::AsRawFd;

    let size = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            c"system.posix_acl_access".as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if size < 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENODATA) | Some(libc::ENOTSUP) => Ok(None),
            _ => Err(error),
        };
    }
    let mut bytes = vec![0u8; size as usize];
    let size = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            c"system.posix_acl_access".as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if size < 0 {
        return Err(io::Error::last_os_error());
    }
    bytes.truncate(size as usize);
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &str = "- id: plugin\n";

    #[cfg(windows)]
    fn clear_readonly(path: &Path) {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, SetFileAttributesW};

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let applied = unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_NORMAL) };
        assert_ne!(applied, 0, "restoring the file attributes failed");
    }

    #[test]
    fn replaces_complete_utf8_content_without_leaking_temp_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        write_patch_layer_atomically(&path, ORIGINAL).unwrap();
        write_patch_layer_atomically(&path, "- id: 中文插件\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- id: 中文插件\n");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn readonly_or_locked_files_are_not_modified_and_temps_are_cleaned() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        std::fs::write(&path, ORIGINAL).unwrap();
        let mut permissions = path.metadata().unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(
            write_patch_layer_atomically(&path, "[]\n")
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), ORIGINAL);
        clear_readonly(&path);
        let lock = File::options()
            .read(true)
            .share_mode(1 | 2)
            .open(&path)
            .unwrap();
        assert!(write_patch_layer_atomically(&path, "[]\n").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), ORIGINAL);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        drop(lock);
    }

    #[cfg(windows)]
    #[test]
    fn restricted_dacl_is_applied_at_temp_creation_and_preserved_on_replacement() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::{
            GetSecurityDescriptorControl, GetSecurityDescriptorDacl, SetFileSecurityW,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        };

        fn dacl(path: &Path) -> Vec<u8> {
            let mut descriptor = security_descriptor(path).unwrap();
            let mut present = 0;
            let mut defaulted = 0;
            let mut acl = std::ptr::null_mut();
            let mut control = 0;
            let mut revision = 0;
            assert_ne!(
                unsafe {
                    GetSecurityDescriptorControl(
                        descriptor.as_mut_ptr().cast(),
                        &mut control,
                        &mut revision,
                    )
                },
                0
            );
            assert_ne!(control & SE_DACL_PROTECTED, 0);
            assert_ne!(
                unsafe {
                    GetSecurityDescriptorDacl(
                        descriptor.as_mut_ptr().cast(),
                        &mut present,
                        &mut acl,
                        &mut defaulted,
                    )
                },
                0
            );
            assert_ne!(present, 0);
            assert!(!acl.is_null());
            unsafe { std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize) }
                .to_vec()
        }

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        std::fs::write(&path, ORIGINAL).unwrap();
        let sddl: Vec<u16> = "D:P(A;;FA;;;OW)".encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            SetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            )
        };
        unsafe { windows_sys::Win32::Foundation::LocalFree(descriptor) };
        assert_ne!(result, 0);
        let before = dacl(&path);
        let staging = create_temp(temp.path(), Some(&path)).unwrap();
        assert_eq!(dacl(staging.path()), before);
        assert_eq!(std::fs::read(staging.path()).unwrap(), b"");
        drop(staging);
        write_patch_layer_atomically(&path, "- id: token\n").unwrap();
        assert_eq!(dacl(&path), before);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- id: token\n");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    fn set_everyone_acl(parent: &Path, file_inherit: bool) {
        use std::os::fd::AsRawFd;

        const ACL_TYPE_EXTENDED: libc::c_int = 0x100;
        const ACL_FIRST_ENTRY: libc::c_int = 0;
        const ACL_EXTENDED_ALLOW: libc::c_int = 1;
        const ACL_READ_DATA: libc::c_int = 1 << 1;
        const ACL_ENTRY_FILE_INHERIT: libc::c_int = 1 << 5;
        const EVERYONE_GUID: [u8; 16] = [
            0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0x00, 0x00,
            0x00, 0x0c,
        ];

        unsafe extern "C" {
            fn acl_init(count: libc::c_int) -> *mut libc::c_void;
            fn acl_create_entry(
                acl: *mut *mut libc::c_void,
                entry: *mut *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_set_tag_type(entry: *mut libc::c_void, tag: libc::c_int) -> libc::c_int;
            fn acl_set_qualifier(
                entry: *mut libc::c_void,
                qualifier: *const libc::c_void,
            ) -> libc::c_int;
            fn acl_get_permset(
                entry: *mut libc::c_void,
                permset: *mut *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_add_perm(permset: *mut libc::c_void, perm: libc::c_int) -> libc::c_int;
            fn acl_set_permset(entry: *mut libc::c_void, permset: *mut libc::c_void)
                -> libc::c_int;
            fn acl_get_flagset_np(
                entry: *mut libc::c_void,
                flagset: *mut *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_add_flag_np(flagset: *mut libc::c_void, flag: libc::c_int) -> libc::c_int;
            fn acl_set_flagset_np(
                entry: *mut libc::c_void,
                flagset: *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_get_flag_np(flagset: *mut libc::c_void, flag: libc::c_int) -> libc::c_int;
            fn acl_set_fd_np(
                fd: libc::c_int,
                acl: *mut libc::c_void,
                kind: libc::c_int,
            ) -> libc::c_int;
            fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
            fn acl_get_entry(
                acl: *mut libc::c_void,
                entry_id: libc::c_int,
                entry: *mut *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_free(obj: *mut libc::c_void) -> libc::c_int;
        }

        let parent = File::open(parent).unwrap();
        unsafe {
            let mut acl = acl_init(1);
            assert!(!acl.is_null());
            let mut entry = std::ptr::null_mut();
            assert_eq!(acl_create_entry(&mut acl, &mut entry), 0);
            assert_eq!(acl_set_tag_type(entry, ACL_EXTENDED_ALLOW), 0);
            assert_eq!(
                acl_set_qualifier(entry, EVERYONE_GUID.as_ptr().cast::<libc::c_void>()),
                0
            );
            let mut permset = std::ptr::null_mut();
            assert_eq!(acl_get_permset(entry, &mut permset), 0);
            assert_eq!(acl_add_perm(permset, ACL_READ_DATA), 0);
            assert_eq!(acl_set_permset(entry, permset), 0);
            let mut flagset = std::ptr::null_mut();
            assert_eq!(acl_get_flagset_np(entry, &mut flagset), 0);
            if file_inherit {
                assert_eq!(acl_add_flag_np(flagset, ACL_ENTRY_FILE_INHERIT), 0);
            }
            assert_eq!(acl_set_flagset_np(entry, flagset), 0);
            assert_eq!(acl_set_fd_np(parent.as_raw_fd(), acl, ACL_TYPE_EXTENDED), 0);
            acl_free(acl);

            let applied = acl_get_fd_np(parent.as_raw_fd(), ACL_TYPE_EXTENDED);
            assert!(!applied.is_null());
            let mut applied_entry = std::ptr::null_mut();
            assert_eq!(
                acl_get_entry(applied, ACL_FIRST_ENTRY, &mut applied_entry),
                0
            );
            let mut applied_flags = std::ptr::null_mut();
            assert_eq!(acl_get_flagset_np(applied_entry, &mut applied_flags), 0);
            assert_eq!(
                acl_get_flag_np(applied_flags, ACL_ENTRY_FILE_INHERIT),
                i32::from(file_inherit)
            );
            acl_free(applied);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_rejects_inherited_acl_before_creating_a_temp_and_keeps_original() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        std::fs::write(&path, ORIGINAL).unwrap();
        write_patch_layer_atomically(&path, "[]\n").unwrap();
        set_everyone_acl(temp.path(), true);
        let error = write_patch_layer_atomically(&path, "- id: secret\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("extended ACL"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]\n");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_allows_parent_acl_without_inheritable_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        std::fs::write(&path, ORIGINAL).unwrap();
        set_everyone_acl(temp.path(), false);
        write_patch_layer_atomically(&path, "- id: token\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- id: token\n");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn unix_identity_and_mode_are_preserved() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        std::fs::write(&path, ORIGINAL).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let before = path.metadata().unwrap();
        write_patch_layer_atomically(&path, "[]\n").unwrap();
        let after = path.metadata().unwrap();
        assert_eq!(
            (after.uid(), after.gid(), after.mode()),
            (before.uid(), before.gid(), before.mode())
        );
        assert_ne!(after.ino(), before.ino());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_access_acl_is_preserved_and_parent_default_acl_is_not_inherited() {
        use std::os::fd::AsRawFd;
        fn acl() -> Vec<u8> {
            let mut bytes = 2u32.to_le_bytes().to_vec();
            for (tag, permission, id) in [
                (1u16, 6u16, u32::MAX),
                (2, 4, 65534),
                (4, 0, u32::MAX),
                (16, 4, u32::MAX),
                (32, 0, u32::MAX),
            ] {
                bytes.extend(tag.to_le_bytes());
                bytes.extend(permission.to_le_bytes());
                bytes.extend(id.to_le_bytes());
            }
            bytes
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cordis.patch.yml");
        let plain = temp.path().join("plain.patch.yml");
        std::fs::write(&path, ORIGINAL).unwrap();
        std::fs::write(&plain, ORIGINAL).unwrap();
        let original = File::open(&path).unwrap();
        let acl = acl();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    original.as_raw_fd(),
                    c"system.posix_acl_access".as_ptr(),
                    acl.as_ptr().cast(),
                    acl.len(),
                    0,
                )
            },
            0
        );
        let parent = File::open(temp.path()).unwrap();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    parent.as_raw_fd(),
                    c"system.posix_acl_default".as_ptr(),
                    acl.as_ptr().cast(),
                    acl.len(),
                    0,
                )
            },
            0
        );
        let before = read_acl(&original).unwrap();
        assert_eq!(before, Some(acl));
        assert_eq!(read_acl(&File::open(&plain).unwrap()).unwrap(), None);
        write_patch_layer_atomically(&path, "[]\n").unwrap();
        write_patch_layer_atomically(&plain, "[]\n").unwrap();
        assert_eq!(read_acl(&File::open(path).unwrap()).unwrap(), before);
        assert_eq!(read_acl(&File::open(plain).unwrap()).unwrap(), None);
    }
}
