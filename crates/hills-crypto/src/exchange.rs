//! 邀請 MAC、裝置綁定 SAS 與 gossip 加密（technical-design §16.2、§16.3、§16.6）。

use hills_proto::gossip::{AAD_PREFIX, GossipEnvelope, GossipMsg};
use hills_proto::{FORMAT_VERSION, KeyId, Pub32, Signed};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{CryptoError, KeyRing, SymmetricKey, open, seal};

/// `K_inv = HKDF-SHA256(secret, "hills/v1/join" ‖ inviteId)`；`mac = blake3::keyed_hash(K_inv, input)`。
pub fn join_mac(secret: &[u8; 16], invite_id: &[u8; 8], input: &[u8]) -> [u8; 32] {
    let mut info = b"hills/v1/join".to_vec();
    info.extend_from_slice(invite_id);
    let mut k = Zeroizing::new([0u8; 32]);
    // 32 bytes 輸出不會超過 HKDF 上限
    let _ = Hkdf::<Sha256>::new(None, secret).expand(&info, k.as_mut());
    *blake3::keyed_hash(&k, input).as_bytes()
}

/// 以常數時間比較 MAC。
pub fn mac_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 裝置綁定用的臨時 X25519 金鑰。
pub struct Ephemeral {
    secret: StaticSecret,
}

impl Ephemeral {
    pub fn generate() -> Result<Self, CryptoError> {
        let mut b = Zeroizing::new([0u8; 32]);
        getrandom::fill(b.as_mut()).map_err(|_| CryptoError::Randomness)?;
        Ok(Self {
            secret: StaticSecret::from(*b),
        })
    }

    pub fn public(&self) -> Pub32 {
        Pub32(PublicKey::from(&self.secret).to_bytes())
    }

    /// 計算綁定通道：回傳 (SAS 6 位數, 通道金鑰)。`old` / `new` 為雙方臨時公鑰，順序固定。
    pub fn link_channel(&self, peer: &Pub32, old: &Pub32, new: &Pub32) -> (String, SymmetricKey) {
        let shared = Zeroizing::new(
            self.secret
                .diffie_hellman(&PublicKey::from(peer.0))
                .to_bytes(),
        );
        let mut h = blake3::Hasher::new();
        h.update(b"hills/v1/sas");
        h.update(&*shared);
        h.update(&old.0);
        h.update(&new.0);
        let d = h.finalize();
        let n = u32::from_be_bytes([
            d.as_bytes()[0],
            d.as_bytes()[1],
            d.as_bytes()[2],
            d.as_bytes()[3],
        ]) % 1_000_000;
        let mut k = Zeroizing::new([0u8; 32]);
        let mut salt = old.0.to_vec();
        salt.extend_from_slice(&new.0);
        let _ = Hkdf::<Sha256>::new(Some(&salt), &*shared).expand(b"hills/v1/link", k.as_mut());
        (format!("{n:06}"), SymmetricKey::from_bytes(&k))
    }
}

fn gossip_aad(key_id: &KeyId) -> Vec<u8> {
    let mut aad = AAD_PREFIX.to_vec();
    aad.push(0);
    aad.extend_from_slice(key_id.to_string().as_bytes());
    aad
}

/// 將已簽章的 gossip 訊息以 GK 加密。
pub fn seal_gossip(
    key_id: &KeyId,
    key: &SymmetricKey,
    msg: &Signed<GossipMsg>,
) -> Result<GossipEnvelope, CryptoError> {
    let plain = Zeroizing::new(hills_proto::encode(msg)?);
    let (nonce, ciphertext) = seal(key, &gossip_aad(key_id), &plain)?;
    Ok(GossipEnvelope {
        v: FORMAT_VERSION,
        key_id: key_id.clone(),
        nonce,
        ciphertext,
    })
}

/// 解密 gossip 訊息；簽章與身分仍需由呼叫端以 TrustStore 驗證。
pub fn open_gossip(env: &GossipEnvelope, ring: &KeyRing) -> Result<Signed<GossipMsg>, CryptoError> {
    hills_proto::check_version(env.v)?;
    let key = ring.get(&env.key_id)?;
    let plain = Zeroizing::new(open(
        key,
        &gossip_aad(&env.key_id),
        &env.nonce,
        &env.ciphertext,
    )?);
    postcard::from_bytes(&plain).map_err(|_| CryptoError::Proto(hills_proto::ProtoError::Decode))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hills_proto::{KeyFamily, Sig64};

    #[test]
    fn join_mac_depends_on_secret_invite_and_input() {
        let m = join_mac(&[1; 16], &[2; 8], b"req");
        assert!(mac_eq(&m, &join_mac(&[1; 16], &[2; 8], b"req")));
        assert!(!mac_eq(&m, &join_mac(&[9; 16], &[2; 8], b"req")));
        assert!(!mac_eq(&m, &join_mac(&[1; 16], &[3; 8], b"req")));
        assert!(!mac_eq(&m, &join_mac(&[1; 16], &[2; 8], b"reQ")));
    }

    #[test]
    fn link_channel_agrees_and_mitm_changes_sas() {
        let old = Ephemeral::generate().unwrap();
        let new = Ephemeral::generate().unwrap();
        let (sas_a, ka) = old.link_channel(&new.public(), &old.public(), &new.public());
        let (sas_b, kb) = new.link_channel(&old.public(), &old.public(), &new.public());
        assert_eq!(sas_a, sas_b);
        assert_eq!(sas_a.len(), 6);
        assert_eq!(*ka.to_bytes(), *kb.to_bytes());
        // 中間人替換公鑰 → 兩邊 SAS 不同
        let mitm = Ephemeral::generate().unwrap();
        let (sas_old, _) = old.link_channel(&mitm.public(), &old.public(), &mitm.public());
        let (sas_new, _) = new.link_channel(&mitm.public(), &mitm.public(), &new.public());
        assert_ne!(sas_old, sas_new);
    }

    #[test]
    fn gossip_roundtrip() {
        let id = KeyId {
            family: KeyFamily::Org,
            epoch: 1,
        };
        let k = SymmetricKey::generate().unwrap();
        let mut ring = KeyRing::default();
        ring.insert(id.clone(), k.clone());
        let msg = Signed {
            body: GossipMsg::RosterChanged,
            signer: Pub32([1; 32]),
            sig: Sig64([2; 64]),
        };
        let env = seal_gossip(&id, &k, &msg).unwrap();
        assert_eq!(open_gossip(&env, &ring).unwrap(), msg);
        let mut bad = env.clone();
        bad.key_id.epoch = 2;
        assert!(open_gossip(&bad, &ring).is_err());
    }
}
