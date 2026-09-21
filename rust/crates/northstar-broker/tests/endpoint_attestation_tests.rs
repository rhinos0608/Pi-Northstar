//! Tier 1 attestation tests: mock UID mismatch rejection.
//! Real cross-UID denial with worker service is Tier 2 only.
//! Same-UID dev workers pass owner peer attestation by design in Tier 1.

use northstar_broker::endpoint::{assert_same_owner, AttestationError, PeerIdentity};

#[test]
fn same_uid_peer_is_accepted() {
    let peer = PeerIdentity { uid: 1000, pid: Some(12345) };
    assert!(assert_same_owner(&peer, 1000).is_ok());
}

#[test]
fn cross_uid_peer_is_rejected() {
    let peer = PeerIdentity { uid: 1001, pid: Some(99999) };
    let result = assert_same_owner(&peer, 1000);
    assert!(matches!(result, Err(AttestationError::UnauthorizedPeer)));
}

#[test]
fn zero_uid_peer_rejected_when_owner_nonzero() {
    let peer = PeerIdentity { uid: 0, pid: None };
    let result = assert_same_owner(&peer, 1000);
    assert!(matches!(result, Err(AttestationError::UnauthorizedPeer)));
}

#[test]
fn pid_optional_does_not_affect_uid_decision() {
    // PID is advisory; same-UID with missing PID still passes
    let peer_no_pid = PeerIdentity { uid: 500, pid: None };
    let peer_with_pid = PeerIdentity { uid: 500, pid: Some(42) };
    assert!(assert_same_owner(&peer_no_pid, 500).is_ok());
    assert!(assert_same_owner(&peer_with_pid, 500).is_ok());
}

#[test]
fn uid_comparison_is_exact_not_range() {
    // UID 999 should not match owner 1000
    let peer = PeerIdentity { uid: 999, pid: None };
    assert!(matches!(assert_same_owner(&peer, 1000), Err(AttestationError::UnauthorizedPeer)));
}
