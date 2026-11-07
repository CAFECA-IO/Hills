//! 對稱金鑰 epoch、HPKE 封裝、加密 change bundle 與靜態加密（technical-design §2、§3.7、§4.1、§4.4、§9）。
//!
//! - 對稱加密：XChaCha20-Poly1305（隨機 24 bytes nonce）
//! - 金鑰封裝：HPKE Base mode，X25519-HKDF-SHA256 / HKDF-SHA256 / ChaCha20Poly1305
//!   - info = `"hills/v1/wrap" ‖ 0x00 ‖ keyId`，AAD = 收件者 MemberId
//! - bundle：AAD = `docId ‖ 0x00 ‖ keyId`，`bundle_hash = blake3(ciphertext)`
//!
//! 只使用 technical-design §2 列出的函式庫；不自行實作任何密碼學原語。

use std::collections::BTreeMap;
use std::fmt;

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hills_identity::MemberKeys;
use hills_proto::{
    EncryptedBundle, FORMAT_VERSION, KeyFamily, KeyId, MemberId, Pub32, SignedChange, WrappedKey,
};
use hpke::{
    Deserializable, OpModeR, OpModeS, Serializable, aead::ChaCha20Poly1305, kdf::HkdfSha256,
    kem::X25519HkdfSha256,
};
use zeroize::Zeroizing;

pub(crate) type Kem = X25519HkdfSha256;
const WRAP_INFO: &[u8] = b"hills/v1/wrap";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("無法取得系統亂數")]
    Randomness,
    #[error("加密失敗")]
    Seal,
    #[error("解密或驗證失敗")]
    Open,
    #[error("找不到金鑰 {0}")]
    MissingKey(String),
    #[error("封裝的收件者不是本人")]
    WrongRecipient,
    #[error("bundle 雜湊不符")]
    HashMismatch,
    #[error("格式錯誤")]
    Proto(#[from] hills_proto::ProtoError),
}

/// 32 bytes 對稱金鑰，drop 時清除。
#[derive(Clone)]
pub struct SymmetricKey(Zeroizing<[u8; 32]>);

impl SymmetricKey {
    pub fn generate() -> Result<Self, CryptoError> {
        let mut k = Zeroizing::new([0u8; 32]);
        getrandom::fill(k.as_mut()).map_err(|_| CryptoError::Randomness)?;
        Ok(Self(k))
    }

    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        Self(Zeroizing::new(*bytes))
    }

    /// 供寫入安全儲存區。
    pub fn to_bytes(&self) -> Zeroizing<[u8; 32]> {
        self.0.clone()
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&*self.0).into())
    }
}

impl fmt::Debug for SymmetricKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SymmetricKey(<redacted>)")
    }
}

fn random_nonce() -> Result<[u8; 24], CryptoError> {
    let mut n = [0u8; 24];
    getrandom::fill(&mut n).map_err(|_| CryptoError::Randomness)?;
    Ok(n)
}

/// XChaCha20-Poly1305 加密；回傳 `(nonce, ciphertext)`。
pub fn seal(
    key: &SymmetricKey,
    aad: &[u8],
    plaintext: &[u8],
) -> Result<([u8; 24], Vec<u8>), CryptoError> {
    let nonce = random_nonce()?;
    let ct = key
        .cipher()
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Seal)?;
    Ok((nonce, ct))
}

pub fn open(
    key: &SymmetricKey,
    aad: &[u8],
    nonce: &[u8; 24],
    ciphertext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    key.cipher()
        .decrypt(
            &XNonce::from(*nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Open)
}

/// 靜態加密格式：`nonce(24) ‖ ciphertext`（technical-design §9）。
pub fn seal_at_rest(
    key: &SymmetricKey,
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let (nonce, ct) = seal(key, aad, plaintext)?;
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open_at_rest(key: &SymmetricKey, aad: &[u8], data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if data.len() < 24 {
        return Err(CryptoError::Open);
    }
    let (nonce, ct) = data.split_at(24);
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| CryptoError::Open)?;
    open(key, aad, &nonce, ct)
}

/// 本機持有的所有金鑰（含歷史 epoch，舊資料仍需解密）。
#[derive(Default, Clone)]
pub struct KeyRing {
    keys: BTreeMap<KeyId, SymmetricKey>,
}

impl fmt::Debug for KeyRing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set()
            .entries(self.keys.keys().map(|k| k.to_string()))
            .finish()
    }
}

impl KeyRing {
    pub fn insert(&mut self, id: KeyId, key: SymmetricKey) {
        self.keys.insert(id, key);
    }

    pub fn get(&self, id: &KeyId) -> Result<&SymmetricKey, CryptoError> {
        self.keys
            .get(id)
            .ok_or_else(|| CryptoError::MissingKey(id.to_string()))
    }

    /// 某個家族目前最新的 epoch。
    pub fn latest(&self, family: &KeyFamily) -> Option<(&KeyId, &SymmetricKey)> {
        self.keys
            .iter()
            .filter(|(id, _)| &id.family == family)
            .max_by_key(|(id, _)| id.epoch)
    }

    /// 下一個 epoch 的 keyId（沒有任何 epoch 時為 1）。
    pub fn next_id(&self, family: &KeyFamily) -> KeyId {
        let epoch = self.latest(family).map_or(1, |(id, _)| id.epoch + 1);
        KeyId {
            family: family.clone(),
            epoch,
        }
    }

    pub fn contains(&self, id: &KeyId) -> bool {
        self.keys.contains_key(id)
    }

    /// 某家族的所有 epoch（由舊到新）。
    pub fn epochs(&self, family: &KeyFamily) -> Vec<(&KeyId, &SymmetricKey)> {
        self.keys
            .iter()
            .filter(|(id, _)| &id.family == family)
            .collect()
    }

    /// 匯出（加密保存用）：postcard of `Vec<(KeyId, [u8; 32])>`。
    pub fn export(&self) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        use zeroize::Zeroize;
        let mut items: Vec<(KeyId, [u8; 32])> =
            self.keys.iter().map(|(id, k)| (id.clone(), *k.0)).collect();
        let out = hills_proto::encode(&items).map(Zeroizing::new);
        for (_, k) in items.iter_mut() {
            k.zeroize();
        }
        Ok(out?)
    }

    pub fn import(bytes: &[u8]) -> Result<Self, CryptoError> {
        use zeroize::Zeroize;
        let mut items: Vec<(KeyId, [u8; 32])> =
            postcard::from_bytes(bytes).map_err(|_| hills_proto::ProtoError::Decode)?;
        let mut ring = Self::default();
        for (id, k) in items.iter_mut() {
            ring.insert(id.clone(), SymmetricKey::from_bytes(k));
            k.zeroize();
        }
        Ok(ring)
    }

    /// 解封裝並加入金鑰圈。
    pub fn accept(&mut self, wrapped: &WrappedKey, me: &MemberKeys) -> Result<KeyId, CryptoError> {
        let key = unwrap_key(wrapped, me)?;
        self.insert(wrapped.key_id.clone(), key);
        Ok(wrapped.key_id.clone())
    }
}

fn wrap_info(key_id: &KeyId) -> Vec<u8> {
    let mut info = WRAP_INFO.to_vec();
    info.push(0);
    info.extend_from_slice(key_id.to_string().as_bytes());
    info
}

/// 以 HPKE 將對稱金鑰封裝給收件者的 EK。
pub fn wrap_key(
    key_id: &KeyId,
    key: &SymmetricKey,
    recipient: MemberId,
    recipient_ek: &Pub32,
) -> Result<WrappedKey, CryptoError> {
    let pk = <Kem as hpke::Kem>::PublicKey::from_bytes(&recipient_ek.0)
        .map_err(|_| CryptoError::Seal)?;
    let (enc, mut ctx) = hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, Kem>(
        &OpModeS::Base,
        &pk,
        &wrap_info(key_id),
    )
    .map_err(|_| CryptoError::Seal)?;
    let ciphertext = ctx
        .seal(&key.0[..], recipient.as_bytes())
        .map_err(|_| CryptoError::Seal)?;
    Ok(WrappedKey {
        v: FORMAT_VERSION,
        key_id: key_id.clone(),
        recipient,
        recipient_ek: *recipient_ek,
        enc: enc.to_bytes().to_vec(),
        ciphertext,
    })
}

/// 以本人的 EK 解封裝。
pub fn unwrap_key(wrapped: &WrappedKey, me: &MemberKeys) -> Result<SymmetricKey, CryptoError> {
    hills_proto::check_version(wrapped.v)?;
    if wrapped.recipient != me.member_id()
        || wrapped.recipient_ek.0 != me.exchange_public().to_bytes()
    {
        return Err(CryptoError::WrongRecipient);
    }
    let sk_bytes = me.exchange_secret_bytes();
    let sk =
        <Kem as hpke::Kem>::PrivateKey::from_bytes(&sk_bytes[..]).map_err(|_| CryptoError::Open)?;
    let enc =
        <Kem as hpke::Kem>::EncappedKey::from_bytes(&wrapped.enc).map_err(|_| CryptoError::Open)?;
    let mut ctx = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(
        &OpModeR::Base,
        &sk,
        &enc,
        &wrap_info(&wrapped.key_id),
    )
    .map_err(|_| CryptoError::Open)?;
    let plain = Zeroizing::new(
        ctx.open(&wrapped.ciphertext, wrapped.recipient.as_bytes())
            .map_err(|_| CryptoError::Open)?,
    );
    let bytes: [u8; 32] = plain.as_slice().try_into().map_err(|_| CryptoError::Open)?;
    Ok(SymmetricKey::from_bytes(&bytes))
}

/// 一次 epoch 輪替的結果：新金鑰與封裝給每位收件者的副本（technical-design §3.7）。
pub struct Rotation {
    pub key_id: KeyId,
    pub key: SymmetricKey,
    pub wrapped: Vec<WrappedKey>,
}

/// 產生下一個 epoch，並封裝給 `recipients`（不含被移除者）。不修改 `ring`，由呼叫端在寫入
/// keys 紀錄成功後 `ring.insert(...)`。
pub fn rotate(
    ring: &KeyRing,
    family: &KeyFamily,
    recipients: &[(MemberId, Pub32)],
) -> Result<Rotation, CryptoError> {
    let key_id = ring.next_id(family);
    let key = SymmetricKey::generate()?;
    let wrapped = recipients
        .iter()
        .map(|(m, ek)| wrap_key(&key_id, &key, *m, ek))
        .collect::<Result<_, _>>()?;
    Ok(Rotation {
        key_id,
        key,
        wrapped,
    })
}

fn bundle_aad(doc_id: &str, key_id: &KeyId) -> Vec<u8> {
    let mut aad = doc_id.as_bytes().to_vec();
    aad.push(0);
    aad.extend_from_slice(key_id.to_string().as_bytes());
    aad
}

/// 將一組 SignedChange 加密成 bundle（technical-design §4.4）。
pub fn seal_bundle(
    doc_id: &str,
    key_id: &KeyId,
    key: &SymmetricKey,
    changes: &[SignedChange],
) -> Result<EncryptedBundle, CryptoError> {
    let plain = Zeroizing::new(hills_proto::encode(&changes)?);
    let (nonce, ciphertext) = seal(key, &bundle_aad(doc_id, key_id), &plain)?;
    let bundle_hash = *blake3::hash(&ciphertext).as_bytes();
    Ok(EncryptedBundle {
        v: FORMAT_VERSION,
        doc_id: doc_id.to_owned(),
        key_id: key_id.clone(),
        nonce,
        ciphertext,
        bundle_hash,
    })
}

/// 解開 bundle；之後每筆 change 仍需經 hills-sync 驗證層驗證簽章與權限。
pub fn open_bundle(
    bundle: &EncryptedBundle,
    ring: &KeyRing,
) -> Result<Vec<SignedChange>, CryptoError> {
    hills_proto::check_version(bundle.v)?;
    if *blake3::hash(&bundle.ciphertext).as_bytes() != bundle.bundle_hash {
        return Err(CryptoError::HashMismatch);
    }
    let key = ring.get(&bundle.key_id)?;
    let plain = Zeroizing::new(open(
        key,
        &bundle_aad(&bundle.doc_id, &bundle.key_id),
        &bundle.nonce,
        &bundle.ciphertext,
    )?);
    let changes: Vec<SignedChange> =
        postcard::from_bytes(&plain).map_err(|_| hills_proto::ProtoError::Decode)?;
    for c in &changes {
        hills_proto::check_version(c.body.v)?;
    }
    Ok(changes)
}

pub mod exchange;

#[cfg(test)]
mod tests {
    use super::*;
    use hills_proto::{Sig64, Signed, SignedChangeBody};

    fn member() -> MemberKeys {
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).unwrap();
        MemberKeys::generate().unwrap().with_member(MemberId(id))
    }

    fn ek(m: &MemberKeys) -> Pub32 {
        Pub32(m.exchange_public().to_bytes())
    }

    fn team() -> KeyFamily {
        KeyFamily::Team("t1".into())
    }

    fn change(i: u8) -> SignedChange {
        Signed {
            body: SignedChangeBody {
                v: FORMAT_VERSION,
                doc_id: "team/t1".into(),
                change_hash: [i; 32],
                author_device: Pub32([1; 32]),
                change: vec![i; 10],
            },
            signer: Pub32([1; 32]),
            sig: Sig64([0; 64]),
        }
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let alice = member();
        let k = SymmetricKey::generate().unwrap();
        let id = KeyId {
            family: team(),
            epoch: 1,
        };
        let w = wrap_key(&id, &k, alice.member_id(), &ek(&alice)).unwrap();
        assert_eq!(*unwrap_key(&w, &alice).unwrap().to_bytes(), *k.to_bytes());
    }

    #[test]
    fn wrong_recipient_cannot_unwrap() {
        let (alice, bob) = (member(), member());
        let k = SymmetricKey::generate().unwrap();
        let id = KeyId {
            family: team(),
            epoch: 1,
        };
        let w = wrap_key(&id, &k, alice.member_id(), &ek(&alice)).unwrap();
        assert_eq!(
            unwrap_key(&w, &bob).unwrap_err(),
            CryptoError::WrongRecipient
        );
        // 把 recipient 改成 bob 也打不開（EK 不同、AAD 不同）
        let mut forged = w.clone();
        forged.recipient = bob.member_id();
        forged.recipient_ek = ek(&bob);
        assert_eq!(unwrap_key(&forged, &bob).unwrap_err(), CryptoError::Open);
        // 封裝給舊 EK（還原前）的項目直接略過
        let renewed = MemberKeys::generate()
            .unwrap()
            .with_member(alice.member_id());
        assert_eq!(
            unwrap_key(&w, &renewed).unwrap_err(),
            CryptoError::WrongRecipient
        );
        // keyId 被竄改 → info 不同
        let mut moved = w;
        moved.key_id.epoch = 2;
        assert_eq!(unwrap_key(&moved, &alice).unwrap_err(), CryptoError::Open);
    }

    #[test]
    fn rotation_excludes_removed_member() {
        let (alice, bob, carol) = (member(), member(), member());
        let mut ring = KeyRing::default();
        let r1 = rotate(
            &ring,
            &team(),
            &[
                (alice.member_id(), ek(&alice)),
                (bob.member_id(), ek(&bob)),
                (carol.member_id(), ek(&carol)),
            ],
        )
        .unwrap();
        assert_eq!(r1.key_id.epoch, 1);
        ring.insert(r1.key_id.clone(), r1.key.clone());
        // carol 離開 → epoch 2 只封裝給 alice、bob
        let r2 = rotate(
            &ring,
            &team(),
            &[(alice.member_id(), ek(&alice)), (bob.member_id(), ek(&bob))],
        )
        .unwrap();
        assert_eq!(r2.key_id.epoch, 2);
        assert!(r2.wrapped.iter().all(|w| w.recipient != carol.member_id()));
        ring.insert(r2.key_id.clone(), r2.key.clone());
        let bundle = seal_bundle("team/t1", &r2.key_id, &r2.key, &[change(1)]).unwrap();
        // carol 只有 epoch 1
        let mut carol_ring = KeyRing::default();
        carol_ring.accept(&r1.wrapped[2], &carol).unwrap();
        assert!(matches!(
            open_bundle(&bundle, &carol_ring),
            Err(CryptoError::MissingKey(_))
        ));
        // bob 收到新 epoch 後可解
        let mut bob_ring = KeyRing::default();
        bob_ring.accept(&r2.wrapped[1], &bob).unwrap();
        assert_eq!(open_bundle(&bundle, &bob_ring).unwrap(), vec![change(1)]);
        assert_eq!(ring.latest(&team()).unwrap().0.epoch, 2);
    }

    #[test]
    fn bundle_roundtrip_and_tamper() {
        let mut ring = KeyRing::default();
        let id = KeyId {
            family: team(),
            epoch: 1,
        };
        let k = SymmetricKey::generate().unwrap();
        ring.insert(id.clone(), k.clone());
        let changes = vec![change(1), change(2), change(3)];
        let b = seal_bundle("team/t1", &id, &k, &changes).unwrap();
        assert_eq!(open_bundle(&b, &ring).unwrap(), changes);

        let mut t = b.clone();
        t.ciphertext[0] ^= 1;
        assert_eq!(
            open_bundle(&t, &ring).unwrap_err(),
            CryptoError::HashMismatch
        );
        t.bundle_hash = *blake3::hash(&t.ciphertext).as_bytes();
        assert_eq!(open_bundle(&t, &ring).unwrap_err(), CryptoError::Open);

        let mut moved = b.clone();
        moved.doc_id = "team/t2".into();
        assert_eq!(open_bundle(&moved, &ring).unwrap_err(), CryptoError::Open);
    }

    #[test]
    fn at_rest_roundtrip() {
        let k = SymmetricKey::generate().unwrap();
        let data = seal_at_rest(&k, b"doc-1", b"secret plan").unwrap();
        assert_eq!(open_at_rest(&k, b"doc-1", &data).unwrap(), b"secret plan");
        assert_eq!(
            open_at_rest(&k, b"doc-2", &data).unwrap_err(),
            CryptoError::Open
        );
        assert_eq!(
            open_at_rest(&SymmetricKey::generate().unwrap(), b"doc-1", &data).unwrap_err(),
            CryptoError::Open
        );
        assert_eq!(
            open_at_rest(&k, b"doc-1", &data[..10]).unwrap_err(),
            CryptoError::Open
        );
    }

    #[test]
    fn keyring_export_import() {
        let mut ring = KeyRing::default();
        let id = KeyId {
            family: team(),
            epoch: 2,
        };
        let k = SymmetricKey::generate().unwrap();
        ring.insert(id.clone(), k.clone());
        let back = KeyRing::import(&ring.export().unwrap()).unwrap();
        assert_eq!(*back.get(&id).unwrap().to_bytes(), *k.to_bytes());
        assert_eq!(back.epochs(&team()).len(), 1);
    }

    #[test]
    fn debug_redacts() {
        let k = SymmetricKey::generate().unwrap();
        assert_eq!(format!("{k:?}"), "SymmetricKey(<redacted>)");
    }

    proptest::proptest! {
        #[test]
        fn seal_open_any(msg in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..512), aad in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..64)) {
            let k = SymmetricKey::generate().unwrap();
            let (n, ct) = seal(&k, &aad, &msg).unwrap();
            proptest::prop_assert_eq!(open(&k, &aad, &n, &ct).unwrap(), msg);
        }
    }
}
