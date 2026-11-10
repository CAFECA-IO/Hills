//! 共用訊息型別（technical-design §2、§3、§4.4、§5）。
//!
//! - 所有型別以 postcard 序列化，並帶 `v` 版本欄位；解碼時版本不符即拒絕。
//! - 需要簽章的型別實作 [`Signable`]，簽章輸入為
//!   `"hills/v1/" ‖ SIGN_TYPE ‖ 0x00 ‖ postcard(body)`（domain separation）。
//! - 本 crate 不含任何密碼學運算；簽章與驗證在 `hills-identity`。

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub mod cafeca;
pub mod gossip;
pub mod mailbox;
pub mod storage;
pub mod sync;
pub mod ticket;

/// 目前的協定 / 資料格式版本。
/// v2（technical-design §17.9）：以 CAFECA 登入，MemberCert、WrappedKey、mailbox 請求格式改變。
pub const FORMAT_VERSION: u8 = 2;
/// 簽章輸入的前綴。
pub const SIGN_PREFIX: &[u8] = b"hills/v1/";

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ProtoError {
    #[error("序列化失敗")]
    Encode,
    #[error("解碼失敗")]
    Decode,
    #[error("不支援的版本 {0}")]
    UnsupportedVersion(u8),
    #[error("格式錯誤：{0}")]
    Invalid(&'static str),
}

/// Unix 毫秒時間戳。
pub type Timestamp = i64;

/// 32 bytes 公鑰（Ed25519 或 X25519），以 hex 顯示。
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Pub32(pub [u8; 32]);

impl fmt::Debug for Pub32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Pub32({})", data_encoding::HEXLOWER.encode(&self.0[..8]))
    }
}

impl fmt::Display for Pub32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&data_encoding::HEXLOWER.encode(&self.0))
    }
}

/// Ed25519 簽章。
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sig64(#[serde(with = "serde_bytes")] pub [u8; 64]);

impl fmt::Debug for Sig64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Sig64(..)")
    }
}

/// 成員 ID：blake3(IK.pub) 前 16 bytes，以小寫 base32（無補齊）顯示（technical-design §3.1）。
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct MemberId(pub [u8; 16]);

impl MemberId {
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    pub fn parse(s: &str) -> Result<Self, ProtoError> {
        let bytes = data_encoding::BASE32_NOPAD
            .decode(s.to_ascii_uppercase().as_bytes())
            .map_err(|_| ProtoError::Invalid("member id"))?;
        Ok(Self(
            bytes
                .try_into()
                .map_err(|_| ProtoError::Invalid("member id"))?,
        ))
    }
}

impl fmt::Display for MemberId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(
            &data_encoding::BASE32_NOPAD
                .encode(&self.0)
                .to_ascii_lowercase(),
        )
    }
}

impl fmt::Debug for MemberId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MemberId({self})")
    }
}

impl FromStr for MemberId {
    type Err = ProtoError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

/// 組織 ID：blake3(OK.pub)。
pub type OrgId = Pub32;

/// 需要簽章的訊息本體。
pub trait Signable: Serialize {
    /// domain separation 用的型別名稱
    const SIGN_TYPE: &'static str;

    fn signing_bytes(&self) -> Result<Vec<u8>, ProtoError> {
        let mut out = Vec::with_capacity(64);
        out.extend_from_slice(SIGN_PREFIX);
        out.extend_from_slice(Self::SIGN_TYPE.as_bytes());
        out.push(0);
        out.extend_from_slice(&postcard::to_allocvec(self).map_err(|_| ProtoError::Encode)?);
        Ok(out)
    }
}

/// 帶版本欄位的型別。
pub trait Versioned {
    fn version(&self) -> u8;
}

/// 已簽章的訊息：`signer` 為簽署者的 Ed25519 公鑰。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signed<T> {
    pub body: T,
    pub signer: Pub32,
    pub sig: Sig64,
}

/// 以 postcard 編碼。
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtoError> {
    postcard::to_allocvec(value).map_err(|_| ProtoError::Encode)
}

/// 以 postcard 解碼，並檢查版本。
pub fn decode<T: DeserializeOwned + Versioned>(bytes: &[u8]) -> Result<T, ProtoError> {
    let value: T = postcard::from_bytes(bytes).map_err(|_| ProtoError::Decode)?;
    check_version(value.version())?;
    Ok(value)
}

/// 解碼不帶版本欄位的輔助型別（例如 `PeerAddr`）。
pub fn decode_unversioned<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ProtoError> {
    postcard::from_bytes(bytes).map_err(|_| ProtoError::Decode)
}

pub fn check_version(v: u8) -> Result<(), ProtoError> {
    if v == FORMAT_VERSION {
        Ok(())
    } else {
        Err(ProtoError::UnsupportedVersion(v))
    }
}

impl<T: Versioned> Versioned for Signed<T> {
    fn version(&self) -> u8 {
        self.body.version()
    }
}

macro_rules! versioned {
    ($($t:ty),*) => { $(impl Versioned for $t { fn version(&self) -> u8 { self.v } })* };
}

// ---------- 身分與憑證（technical-design §3） ----------

/// 憑證中的角色。小組負責人屬於 org 文件中的小組設定，不寫在憑證內。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Role {
    Admin,
    Member,
}

/// `DeviceCert = Sign_IK(memberId, DK.pub, deviceName, issuedAt)`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceCert {
    pub v: u8,
    pub member_id: MemberId,
    pub device_pub: Pub32,
    pub device_name: String,
    pub issued_at: Timestamp,
    pub expires_at: Option<Timestamp>,
}

impl Signable for DeviceCert {
    const SIGN_TYPE: &'static str = "device-cert";
}

/// `MemberCert = Sign_admin(memberId, IK.pub, EK.pub, roles, cafeca, issuedAt)`（technical-design §3.1、§17）。
/// `member_id` 必須由 `cafeca` 推導；同一成員以 `issued_at` 最新者為準（還原換發）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberCert {
    pub v: u8,
    pub org_id: OrgId,
    pub member_id: MemberId,
    pub ik_pub: Pub32,
    pub ek_pub: Pub32,
    pub roles: Vec<Role>,
    pub cafeca: cafeca::CafecaAccount,
    pub issued_at: Timestamp,
}

impl MemberCert {
    pub fn is_admin(&self) -> bool {
        self.roles.contains(&Role::Admin)
    }
}

impl Signable for MemberCert {
    const SIGN_TYPE: &'static str = "member-cert";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RevocationTarget {
    Member(MemberId),
    Device(Pub32),
}

/// 撤銷：成員由管理者撤銷；裝置由成員本人或管理者撤銷（technical-design §3.6–3.7）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revocation {
    pub v: u8,
    pub org_id: OrgId,
    pub target: RevocationTarget,
    pub reason: String,
    pub at: Timestamp,
}

impl Signable for Revocation {
    const SIGN_TYPE: &'static str = "revocation";
}

/// 管理者推送給 mailbox 的 roster 快照（technical-design §5.2）。每筆憑證仍各自驗證。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roster {
    pub v: u8,
    pub org_id: OrgId,
    pub member_certs: Vec<Signed<MemberCert>>,
    /// v0.7（technical-design §16.7）：mailbox 也分發裝置憑證
    pub device_certs: Vec<Signed<DeviceCert>>,
    pub revocations: Vec<Signed<Revocation>>,
    pub issued_at: Timestamp,
}

impl Signable for Roster {
    const SIGN_TYPE: &'static str = "roster";
}

// ---------- 同步（technical-design §4.2） ----------

/// 一筆 Automerge change 與其作者裝置簽章。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedChangeBody {
    pub v: u8,
    pub doc_id: String,
    pub change_hash: [u8; 32],
    pub author_device: Pub32,
    /// Automerge change 原始位元組
    #[serde(with = "serde_bytes")]
    pub change: Vec<u8>,
}

impl Signable for SignedChangeBody {
    const SIGN_TYPE: &'static str = "change";
}

pub type SignedChange = Signed<SignedChangeBody>;

// ---------- 金鑰與加密封包（technical-design §4.1、§4.4） ----------

/// 金鑰家族（keyId 的前半段）。
///
/// postcard 以變體的**順序**編碼（封包、金鑰庫、信箱都存這個值），
/// 新變體只能加在最後，不能插在中間或調整順序。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum KeyFamily {
    Org,
    Team(String),
    MemberAttendance(MemberId),
    MemberPrivate(MemberId),
    Conv(String),
    /// 對話 meta 專用金鑰（technical-design §14.1 v0.9）；新成員取得全部 epoch
    ConvMeta(String),
    /// 工作紀錄金鑰 WK（technical-design §16.18 v0.34，D62）：本人與本人所屬小組的負責人
    MemberWorklog(MemberId),
}

/// `<family>:epoch:<n>`，n 從 1 開始。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct KeyId {
    pub family: KeyFamily,
    pub epoch: u32,
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && !s.contains(':') && !s.contains('/')
}

impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.family {
            KeyFamily::Org => write!(f, "org"),
            KeyFamily::Team(t) => write!(f, "team:{t}"),
            KeyFamily::MemberAttendance(m) => write!(f, "member:{m}:attendance"),
            KeyFamily::MemberPrivate(m) => write!(f, "member:{m}:private"),
            KeyFamily::MemberWorklog(m) => write!(f, "member:{m}:worklog"),
            KeyFamily::Conv(c) => write!(f, "conv:{c}"),
            KeyFamily::ConvMeta(c) => write!(f, "conv:{c}:meta"),
        }?;
        write!(f, ":epoch:{}", self.epoch)
    }
}

impl FromStr for KeyId {
    type Err = ProtoError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bad = ProtoError::Invalid("key id");
        let (head, epoch) = s.rsplit_once(":epoch:").ok_or(bad.clone())?;
        let epoch: u32 = epoch.parse().map_err(|_| bad.clone())?;
        if epoch == 0 {
            return Err(bad);
        }
        let parts: Vec<&str> = head.split(':').collect();
        let family = match parts.as_slice() {
            ["org"] => KeyFamily::Org,
            ["team", t] if valid_segment(t) => KeyFamily::Team((*t).to_owned()),
            ["conv", c] if valid_segment(c) => KeyFamily::Conv((*c).to_owned()),
            ["conv", c, "meta"] if valid_segment(c) => KeyFamily::ConvMeta((*c).to_owned()),
            ["member", m, "attendance"] => KeyFamily::MemberAttendance(MemberId::parse(m)?),
            ["member", m, "private"] => KeyFamily::MemberPrivate(MemberId::parse(m)?),
            ["member", m, "worklog"] => KeyFamily::MemberWorklog(MemberId::parse(m)?),
            _ => return Err(bad),
        };
        Ok(Self { family, epoch })
    }
}

/// 以 HPKE 封裝給某位成員 EK 的對稱金鑰。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedKey {
    pub v: u8,
    pub key_id: KeyId,
    pub recipient: MemberId,
    /// 封裝對象的 EK（還原換發後舊 EK 的封裝不再適用，technical-design §17.7）
    pub recipient_ek: Pub32,
    #[serde(with = "serde_bytes")]
    pub enc: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

/// 交給 mailbox 保存的加密 change bundle（technical-design §4.4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedBundle {
    pub v: u8,
    pub doc_id: String,
    pub key_id: KeyId,
    #[serde(with = "serde_bytes")]
    pub nonce: [u8; 24],
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
    pub bundle_hash: [u8; 32],
}

impl Signable for WrappedKey {
    const SIGN_TYPE: &'static str = "wrapped-key";
}

/// iroh 端點位址，不依賴 iroh 型別（轉換在 hills-net）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PeerAddr {
    pub node: Pub32,
    pub relay: Option<String>,
    pub direct: Vec<String>,
}

versioned!(
    DeviceCert,
    MemberCert,
    Revocation,
    Roster,
    SignedChangeBody,
    WrappedKey,
    EncryptedBundle
);

#[cfg(test)]
mod tests {
    /// 已存在的資料以變體順序編碼；順序變了舊的封包與金鑰就解不開（「格式錯誤」）。
    #[test]
    fn key_family_wire_tags_are_stable() {
        let m = MemberId([0xab; 16]);
        let tag = |f: KeyFamily| encode(&f).unwrap()[0];
        assert_eq!(tag(KeyFamily::Org), 0);
        assert_eq!(tag(KeyFamily::Team("t".into())), 1);
        assert_eq!(tag(KeyFamily::MemberAttendance(m)), 2);
        assert_eq!(tag(KeyFamily::MemberPrivate(m)), 3);
        assert_eq!(tag(KeyFamily::Conv("c".into())), 4);
        assert_eq!(tag(KeyFamily::ConvMeta("c".into())), 5);
        assert_eq!(tag(KeyFamily::MemberWorklog(m)), 6);
    }

    use super::*;

    fn mid(b: u8) -> MemberId {
        MemberId([b; 16])
    }

    #[test]
    fn signing_bytes_have_domain_separation() {
        let cert = DeviceCert {
            v: 1,
            member_id: mid(1),
            device_pub: Pub32([2; 32]),
            device_name: "MacBook".into(),
            issued_at: 1,
            expires_at: None,
        };
        let bytes = cert.signing_bytes().unwrap();
        assert!(bytes.starts_with(b"hills/v1/device-cert\0"));
        // 相同內容不同型別，簽章輸入不同
        let rev = Revocation {
            v: 1,
            org_id: Pub32([0; 32]),
            target: RevocationTarget::Member(mid(1)),
            reason: String::new(),
            at: 1,
        };
        assert!(
            rev.signing_bytes()
                .unwrap()
                .starts_with(b"hills/v1/revocation\0")
        );
    }

    #[test]
    fn roundtrip_and_version_check() {
        let b = EncryptedBundle {
            v: FORMAT_VERSION,
            doc_id: "team/t1".into(),
            key_id: KeyId {
                family: KeyFamily::Team("t1".into()),
                epoch: 3,
            },
            nonce: [7; 24],
            ciphertext: vec![1, 2, 3],
            bundle_hash: [9; 32],
        };
        let enc = encode(&b).unwrap();
        assert_eq!(decode::<EncryptedBundle>(&enc).unwrap(), b);
        let mut future = b.clone();
        future.v = FORMAT_VERSION + 1;
        assert_eq!(
            decode::<EncryptedBundle>(&encode(&future).unwrap()),
            Err(ProtoError::UnsupportedVersion(FORMAT_VERSION + 1))
        );
        assert_eq!(
            decode::<EncryptedBundle>(&[0xff, 0xff]),
            Err(ProtoError::Decode)
        );
    }

    #[test]
    fn key_id_format() {
        let m = mid(5);
        let cases = [
            (KeyFamily::Org, "org:epoch:1".to_string()),
            (KeyFamily::Team("t1".into()), "team:t1:epoch:1".into()),
            (KeyFamily::Conv("c9".into()), "conv:c9:epoch:1".into()),
            (
                KeyFamily::ConvMeta("c9".into()),
                "conv:c9:meta:epoch:1".into(),
            ),
            (
                KeyFamily::MemberAttendance(m),
                format!("member:{m}:attendance:epoch:1"),
            ),
            (
                KeyFamily::MemberPrivate(m),
                format!("member:{m}:private:epoch:1"),
            ),
            (
                KeyFamily::MemberWorklog(m),
                format!("member:{m}:worklog:epoch:1"),
            ),
        ];
        for (family, s) in cases {
            let id = KeyId { family, epoch: 1 };
            assert_eq!(id.to_string(), s);
            assert_eq!(s.parse::<KeyId>().unwrap(), id);
        }
        for bad in [
            "org",
            "org:epoch:0",
            "team::epoch:1",
            "x:epoch:1",
            "member:zz:private:epoch:1",
        ] {
            assert!(bad.parse::<KeyId>().is_err(), "{bad}");
        }
    }

    #[test]
    fn member_id_display_roundtrip() {
        let m = MemberId([0xab; 16]);
        assert_eq!(m.to_string().len(), 26);
        assert_eq!(m.to_string().parse::<MemberId>().unwrap(), m);
    }
}
