//! Server-owned capability grant ceiling.
//! Client requests can never expand beyond CLI_GRANT_CEILING.

use crate::protocol::BrokerCapability;

/// Fixed server-owned grant ceiling for CLI clients.
/// Client-supplied capability requests are intersected with this set.
pub const CLI_GRANT_CEILING: &[BrokerCapability] = &[
    BrokerCapability::RuntimeNegotiate,
    BrokerCapability::RuntimeStart,
    BrokerCapability::RuntimeStatus,
    BrokerCapability::RuntimeResult,
    BrokerCapability::RuntimeCancel,
];

/// Intersect requested capabilities against the server-owned ceiling.
/// Returns only capabilities present in both requested and ceiling.
/// Client cannot expand the grant beyond what the ceiling allows.
pub fn intersect_capabilities(requested: &[BrokerCapability]) -> Vec<BrokerCapability> {
    requested
        .iter()
        .filter(|cap| CLI_GRANT_CEILING.contains(cap))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::BrokerCapability;

    #[test]
    fn empty_request_yields_empty_grant() {
        assert!(intersect_capabilities(&[]).is_empty());
    }

    #[test]
    fn full_ceiling_request_granted_in_full() {
        let result = intersect_capabilities(CLI_GRANT_CEILING);
        assert_eq!(result.len(), CLI_GRANT_CEILING.len());
    }

    #[test]
    fn subset_request_yields_subset_grant() {
        let req = vec![BrokerCapability::RuntimeStatus, BrokerCapability::RuntimeCancel];
        let result = intersect_capabilities(&req);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&BrokerCapability::RuntimeStatus));
        assert!(result.contains(&BrokerCapability::RuntimeCancel));
    }
}
