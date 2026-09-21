//! Unix peer credential retrieval via SO_PEERCRED (Linux) and getpeereid (macOS).
//! 
//! macOS: Uses getpeereid for UID/GID. LOCAL_PEERPID is available via getsockopt
//! on macOS 12+ but subject to PID-recycling TOCTOU. See ADR 0010 R-2.
//! The UID check is authoritative; PID is advisory/best-effort.

use std::os::unix::io::RawFd;
use std::io;
use super::PeerIdentity;

#[cfg(target_os = "linux")]
pub fn get_peer_identity(fd: RawFd) -> io::Result<PeerIdentity> {
    use libc::{getsockopt, ucred, SOL_SOCKET, SO_PEERCRED};
    let mut cred: ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<ucred>() as libc::socklen_t;
    let ret = unsafe {
        getsockopt(
            fd,
            SOL_SOCKET,
            SO_PEERCRED,
            &mut cred as *mut ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PeerIdentity { uid: cred.uid, pid: Some(cred.pid as u32) })
}

#[cfg(target_os = "macos")]
pub fn get_peer_identity(fd: RawFd) -> io::Result<PeerIdentity> {
    use libc::{getpeereid};
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let ret = unsafe { getpeereid(fd, &mut uid, &mut gid) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // PID via LOCAL_PEERPID (advisory, TOCTOU residual documented in ADR 0010 R-2)
    let pid = get_peer_pid(fd).ok();
    Ok(PeerIdentity { uid, pid })
}

#[cfg(target_os = "macos")]
fn get_peer_pid(fd: RawFd) -> io::Result<u32> {
    // LOCAL_PEERPID = 2, SOL_LOCAL = 0 on macOS
    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERPID: libc::c_int = 2;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let ret = unsafe {
        libc::getsockopt(
            fd,
            SOL_LOCAL,
            LOCAL_PEERPID,
            &mut pid as *mut libc::pid_t as *mut libc::c_void,
            &mut len,
        )
    };
    if ret != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(pid as u32)
    }
}

// Fallback stub for other Unix targets
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn get_peer_identity(_fd: RawFd) -> io::Result<PeerIdentity> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "peer credentials unavailable on this platform"))
}
