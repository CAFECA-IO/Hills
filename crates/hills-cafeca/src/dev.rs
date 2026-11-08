//! 開發測試模式（technical-design §17.10，D44）：以測試帳號名稱登入，不經 CAFECA。
//!
//! 測試帳號沒有簽章保護，只能用於測試伺服器（mailbox `HILLS_DEV_LOGIN=1`）與 debug 建置的 app。

use hills_proto::FORMAT_VERSION;
use hills_proto::cafeca::{
    APP_DOMAIN, CafecaAccount, CafecaProof, MAX_SIGNIN_TTL, SignInBinding, SignInMessage,
};

use crate::CafecaError;
use crate::request::nonce_for;
use crate::verify::{Verified, check_offline};

/// 測試帳號的鏈 ID（不是任何真實鏈）。
pub const DEV_CHAIN_ID: u64 = 0;
/// 測試登入證明的固定簽章。
pub const DEV_SIGNATURE: &[u8] = b"hills/v1/dev-login/no-signature";

/// 測試帳號名稱正規化：去頭尾空白、轉小寫，限 `[a-z0-9_]{2,32}`。
pub fn normalize_dev_name(name: &str) -> Option<String> {
    let n = name.trim().to_ascii_lowercase();
    let ok = (2..=32).contains(&n.len())
        && n.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    ok.then_some(n)
}

/// 由（已正規化的）名稱推導測試帳戶：`blake3("hills/v1/dev-account" ‖ name)[0..20]`，鏈 ID 0。
pub fn dev_account(name: &str) -> CafecaAccount {
    let mut h = blake3::Hasher::new();
    h.update(b"hills/v1/dev-account");
    h.update(name.as_bytes());
    let mut address = [0u8; 20];
    address.copy_from_slice(&h.finalize().as_bytes()[..20]);
    CafecaAccount {
        chain_id: DEV_CHAIN_ID,
        address,
    }
}

/// 在本機組出測試登入證明（binding、nonce、message 與正式流程相同）。
pub fn dev_proof(binding: SignInBinding, name: &str) -> Result<CafecaProof, CafecaError> {
    let name = normalize_dev_name(name).ok_or(CafecaError::Invalid("測試帳號名稱格式不符"))?;
    let issued_at = binding.issued_at;
    Ok(CafecaProof {
        v: FORMAT_VERSION,
        account: dev_account(&name),
        message: SignInMessage {
            domain: APP_DOMAIN.into(),
            uri: APP_DOMAIN.into(),
            nonce: nonce_for(&binding),
            issued_at,
            expires_at: issued_at + MAX_SIGNIN_TTL,
            statement: "dev login".into(),
            claims: "handle".into(),
            channel: String::new(),
        },
        binding,
        signature: DEV_SIGNATURE.to_vec(),
        handle: Some(name),
    })
}

/// 驗證測試登入證明（只接受鏈 ID 0）。
pub fn verify_dev(proof: &CafecaProof, received_at: u64) -> Result<Verified, CafecaError> {
    if proof.account.chain_id != DEV_CHAIN_ID {
        return Err(CafecaError::Invalid("鏈 ID 不符"));
    }
    check_offline(proof, received_at)?;
    if proof.signature != DEV_SIGNATURE {
        return Err(CafecaError::BadSignature);
    }
    let name = proof
        .handle
        .as_deref()
        .and_then(normalize_dev_name)
        .ok_or(CafecaError::Invalid("測試帳號名稱格式不符"))?;
    if proof.handle.as_deref() != Some(name.as_str()) || dev_account(&name) != proof.account {
        return Err(CafecaError::Invalid("測試帳戶與名稱不符"));
    }
    Ok(Verified {
        account: proof.account,
        handle: Some(name),
    })
}

#[cfg(test)]
mod tests {
    use hills_proto::cafeca::SignInKind;

    use super::*;
    use crate::request::tests::binding;
    use crate::verify::Verifier;

    #[test]
    fn names() {
        assert_eq!(normalize_dev_name(" Alice_1 ").as_deref(), Some("alice_1"));
        assert!(normalize_dev_name("a").is_none());
        assert!(normalize_dev_name(&"a".repeat(33)).is_none());
        assert!(normalize_dev_name("a-b").is_none());
        assert!(normalize_dev_name("小明").is_none());
        assert_eq!(dev_account("alice"), dev_account("alice"));
        assert_ne!(dev_account("alice").address, dev_account("bob").address);
        assert_eq!(dev_account("alice").chain_id, 0);
    }

    #[tokio::test]
    async fn dev_verifier() {
        let p = dev_proof(binding(SignInKind::Join, 1_000), "Alice").unwrap();
        assert_eq!(p.handle.as_deref(), Some("alice"));
        let v = Verifier::Dev { rpc: None };
        let ok = v.verify(&p, 1_100).await.unwrap();
        assert_eq!(ok.account, dev_account("alice"));
        assert_eq!(ok.handle.as_deref(), Some("alice"));

        let mut bad = p.clone();
        bad.signature = vec![1; 64];
        assert!(v.verify(&bad, 1_100).await.is_err());
        let mut bad = p.clone();
        bad.handle = Some("bob".into());
        assert!(v.verify(&bad, 1_100).await.is_err());
        let mut bad = p.clone();
        bad.binding.device_pub.0[0] ^= 1;
        assert!(v.verify(&bad, 1_100).await.is_err());
        assert!(v.verify(&p, 2_000).await.is_err());
        // 其他鏈且未設定錢包：拒絕
        let mut real = p.clone();
        real.account.chain_id = 8018;
        assert!(v.verify(&real, 1_100).await.is_err());
        // 正式驗證器不接受測試證明
        let rpc = Verifier::Rpc(crate::RpcVerifier::new("http://127.0.0.1:9", None).unwrap());
        assert!(rpc.verify(&p, 1_100).await.is_err());
        assert!(dev_proof(binding(SignInKind::Join, 1_000), "x").is_err());
    }
}
