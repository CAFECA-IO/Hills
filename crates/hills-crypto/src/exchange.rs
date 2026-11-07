//! 新裝置金鑰封裝與 gossip 加密（technical-design §16.6、§17.6）。

use hills_proto::gossip::{AAD_PREFIX, GossipEnvelope, GossipMsg};
use hills_proto::{FORMAT_VERSION, KeyId, Pub32, Signed};
use hpke::{
    Deserializable, OpModeR, OpModeS, Serializable, aead::ChaCha20Poly1305, kdf::HkdfSha256,
};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{CryptoError, Kem, KeyRing, SymmetricKey, open, seal};

const GRANT_INFO: &[u8] = b"hills/v1/device-grant";
/// HPKE X25519 封裝金鑰長度。
const ENC_LEN: usize = 32;

/// 新裝置的臨時 X25519 金鑰（§17.6）：公鑰寫進 CAFECA 登入綁定，本人其他裝置以 HPKE 封裝成員金鑰給它。
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

    pub fn from_secret_bytes(b: &[u8; 32]) -> Self {
        Self {
            secret: StaticSecret::from(*b),
        }
    }

    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.secret.to_bytes())
    }

    pub fn public(&self) -> Pub32 {
        Pub32(PublicKey::from(&self.secret).to_bytes())
    }

    /// 解開封裝給本裝置的成員金鑰；`device` 為本裝置 DK（AAD）。
    pub fn open_grant(
        &self,
        device: &Pub32,
        sealed: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        if sealed.len() < ENC_LEN {
            return Err(CryptoError::Open);
        }
        let (enc, ct) = sealed.split_at(ENC_LEN);
        let sk = <Kem as hpke::Kem>::PrivateKey::from_bytes(&self.secret.to_bytes())
            .map_err(|_| CryptoError::Open)?;
        let enc =
            <Kem as hpke::Kem>::EncappedKey::from_bytes(enc).map_err(|_| CryptoError::Open)?;
        let mut ctx = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(
            &OpModeR::Base,
            &sk,
            &enc,
            GRANT_INFO,
        )
        .map_err(|_| CryptoError::Open)?;
        Ok(Zeroizing::new(
            ctx.open(ct, &device.0).map_err(|_| CryptoError::Open)?,
        ))
    }
}

/// 以 HPKE 把成員金鑰封裝給新裝置的臨時公鑰；輸出 `enc ‖ ciphertext`。
pub fn seal_grant(
    eph_pub: &Pub32,
    device: &Pub32,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let pk =
        <Kem as hpke::Kem>::PublicKey::from_bytes(&eph_pub.0).map_err(|_| CryptoError::Seal)?;
    let (enc, mut ctx) =
        hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeS::Base, &pk, GRANT_INFO)
            .map_err(|_| CryptoError::Seal)?;
    let mut out = enc.to_bytes().to_vec();
    out.extend(
        ctx.seal(plaintext, &device.0)
            .map_err(|_| CryptoError::Seal)?,
    );
    Ok(out)
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
    fn grant_roundtrip_binds_device() {
        let eph = Ephemeral::generate().unwrap();
        let dev = Pub32([5; 32]);
        let sealed = seal_grant(&eph.public(), &dev, b"secret keys").unwrap();
        assert_eq!(&eph.open_grant(&dev, &sealed).unwrap()[..], b"secret keys");
        assert!(eph.open_grant(&Pub32([6; 32]), &sealed).is_err());
        let other = Ephemeral::generate().unwrap();
        assert!(other.open_grant(&dev, &sealed).is_err());
        assert!(eph.open_grant(&dev, &sealed[..10]).is_err());
        let again = Ephemeral::from_secret_bytes(&eph.secret_bytes());
        assert_eq!(again.public(), eph.public());
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
