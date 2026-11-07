//! EIP-712 `SignIn` 結構雜湊（CAFECA README §4）。
//!
//! ```text
//! domain  = { name: "CAFECA Sign-In", version: "1", chainId, verifyingContract: account }
//! SignIn  = (string domain, string uri, string nonce, uint256 issuedAt, uint256 expiresAt,
//!            string statement, string claims, string channel)
//! ```

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::{Eip712Domain, SolStruct, sol};
use hills_proto::cafeca::{CafecaAccount, SignInMessage};

sol! {
    struct SignIn {
        string domain;
        string uri;
        string nonce;
        uint256 issuedAt;
        uint256 expiresAt;
        string statement;
        string claims;
        string channel;
    }

    /// ERC-1271
    function isValidSignature(bytes32 hash, bytes signature) external view returns (bytes4);

    /// CAFECA Recovery 模組
    function isPending(address account) external view returns (bool);
}

/// ERC-1271 成功時的回傳值。
pub const MAGIC_1271: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// `hashTypedData(domain, SignIn, message)`。
pub fn sign_in_hash(account: &CafecaAccount, m: &SignInMessage) -> [u8; 32] {
    let domain = Eip712Domain::new(
        Some("CAFECA Sign-In".into()),
        Some("1".into()),
        Some(U256::from(account.chain_id)),
        Some(Address::from(account.address)),
        None::<B256>,
    );
    let s = SignIn {
        domain: m.domain.clone(),
        uri: m.uri.clone(),
        nonce: m.nonce.clone(),
        issuedAt: U256::from(m.issued_at),
        expiresAt: U256::from(m.expires_at),
        statement: m.statement.clone(),
        claims: m.claims.clone(),
        channel: m.channel.clone(),
    };
    s.eip712_signing_hash(&domain).0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 由 CAFECA repo `app/scripts/native-signin-check.mts`（viem `hashTypedData`）產生的向量。
    #[test]
    fn matches_cafeca_vector() {
        let account = CafecaAccount {
            chain_id: 8018,
            address: [0x11; 20],
        };
        let m = SignInMessage {
            domain: "app://io.cafeca.hills".into(),
            uri: "app://io.cafeca.hills".into(),
            nonce: "q5Yk0n7m1cVbT2xG8sJfL4hW9eR3aZ6uN0pD5iO7kQc".into(),
            issued_at: 1_800_000_000,
            expires_at: 1_800_000_600,
            statement: "加入「範例組織」· 確認碼 K7QD-M2XA".into(),
            claims: "handle".into(),
            channel: String::new(),
        };
        assert_eq!(
            data_encoding::HEXLOWER.encode(&sign_in_hash(&account, &m)),
            "f48677de47c729abd192b191211305b057c459baaddf463e549dea64124e6053"
        );
    }
}
