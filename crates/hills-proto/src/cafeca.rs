//! 以 CAFECA 登入的訊息型別（technical-design §17，D41）。
//!
//! 密碼學運算（nonce 雜湊、EIP-712、鏈上驗證）在 `hills-cafeca`；本模組只定義資料格式。

use serde::{Deserialize, Serialize};

use crate::{DeviceCert, OrgId, Pub32, Signed};

/// 登入請求的 `domain` 與 `uri`（Hills 桌機 App 的套件識別碼，§17.1）。
pub const APP_DOMAIN: &str = "app://io.cafeca.hills";
/// 登入請求最長有效時間（秒），與 CAFECA 相同。
pub const MAX_SIGNIN_TTL: u64 = 600;

/// CAFECA 帳戶：鏈 ID 與身分合約地址（§3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CafecaAccount {
    pub chain_id: u64,
    pub address: [u8; 20],
}

impl CafecaAccount {
    /// `0x` 開頭的小寫十六進位地址。
    pub fn address_hex(&self) -> String {
        format!("0x{}", data_encoding::HEXLOWER.encode(&self.address))
    }

    /// CAIP-10 形式：`eip155:<chainId>:<address>`（org 文件 `members[id].cafeca`）。
    pub fn caip10(&self) -> String {
        format!("eip155:{}:{}", self.chain_id, self.address_hex())
    }

    /// 顯示用縮寫：`0x1234…abcd`。
    pub fn short(&self) -> String {
        let h = self.address_hex();
        format!("{}…{}", &h[..6], &h[h.len() - 4..])
    }

    /// 解析 `0x` 開頭的 40 位十六進位地址（大小寫皆可）。
    pub fn parse_address(s: &str) -> Option<[u8; 20]> {
        let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
        if hex.len() != 40 {
            return None;
        }
        data_encoding::HEXLOWER_PERMISSIVE
            .decode(hex.as_bytes())
            .ok()?
            .try_into()
            .ok()
    }
}

/// 登入的用途（§17.3）。`Join` 同時用於加入與新增裝置：是否已是成員由 mailbox 依帳戶判斷。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SignInKind {
    Create,
    Join,
    Recover,
}

/// 登入簽章綁定的內容；`nonce = base64url(blake3("hills/v1/cafeca-signin" ‖ postcard(binding)))`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInBinding {
    pub v: u8,
    pub org_id: OrgId,
    pub kind: SignInKind,
    /// 申請裝置的 DK
    pub device_pub: Pub32,
    /// 新的 IK
    pub ik_pub: Option<Pub32>,
    /// 新的 EK；新增裝置時作為接收成員金鑰封裝的臨時公鑰
    pub key_pub: Pub32,
    /// Unix 秒，等於 `SignInMessage.issued_at`
    pub issued_at: u64,
}

/// 使用者在 CAFECA 簽署的 EIP-712 `SignIn` 訊息（CAFECA README §4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInMessage {
    pub domain: String,
    pub uri: String,
    pub nonce: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub statement: String,
    pub claims: String,
    pub channel: String,
}

/// 登入證明（§17.4）：可由任何人以鏈上 `isValidSignature` 驗證。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CafecaProof {
    pub v: u8,
    pub binding: SignInBinding,
    pub account: CafecaAccount,
    pub message: SignInMessage,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
    /// 回應中自稱的代稱，只供顯示
    pub handle: Option<String>,
}

/// 加入或還原申請（§17.6、§17.7）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinApplication {
    pub v: u8,
    pub proof: CafecaProof,
    pub ik_pub: Pub32,
    pub ek_pub: Pub32,
    pub device_cert: Signed<DeviceCert>,
    pub name: String,
}

/// 新裝置申請（§17.6）：由 mailbox 把「已是成員」的加入申請轉成此形式，`eph_pub` 為申請時的 EK。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceApplication {
    pub v: u8,
    pub proof: CafecaProof,
    pub device_pub: Pub32,
    pub eph_pub: Pub32,
    pub name: String,
}

/// 經 mailbox 投遞的申請。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Application {
    Join(JoinApplication),
    Recover(JoinApplication),
    Device(DeviceApplication),
}

impl Application {
    pub fn proof(&self) -> &CafecaProof {
        match self {
            Self::Join(a) | Self::Recover(a) => &a.proof,
            Self::Device(a) => &a.proof,
        }
    }

    /// 申請裝置的 DK（mailbox 以此識別申請）。
    pub fn device_pub(&self) -> Pub32 {
        match self {
            Self::Join(a) | Self::Recover(a) => a.device_cert.body.device_pub,
            Self::Device(a) => a.device_pub,
        }
    }

    /// 登入綁定應有的用途。
    pub fn binding_kind(&self) -> SignInKind {
        match self {
            Self::Join(_) | Self::Device(_) => SignInKind::Join,
            Self::Recover(_) => SignInKind::Recover,
        }
    }

    /// 已是成員的加入申請轉成新裝置申請（§17.6）。
    pub fn into_device(self) -> Self {
        match self {
            Self::Join(a) => Self::Device(DeviceApplication {
                v: a.v,
                device_pub: a.device_cert.body.device_pub,
                eph_pub: a.ek_pub,
                name: a.device_cert.body.device_name.clone(),
                proof: a.proof,
            }),
            other => other,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Join(a) | Self::Recover(a) => &a.name,
            Self::Device(a) => &a.name,
        }
    }

    /// 申請內容與登入綁定一致（金鑰、裝置、用途）。鏈上簽章另由 `hills-cafeca` 驗證。
    pub fn binding_consistent(&self, org_id: &OrgId) -> bool {
        let b = &self.proof().binding;
        if b.org_id != *org_id || b.kind != self.binding_kind() || b.device_pub != self.device_pub()
        {
            return false;
        }
        match self {
            Self::Join(a) | Self::Recover(a) => {
                b.ik_pub == Some(a.ik_pub)
                    && b.key_pub == a.ek_pub
                    && a.device_cert.signer == a.ik_pub
            }
            Self::Device(a) => b.key_pub == a.eph_pub,
        }
    }
}

/// 封裝給新裝置的成員金鑰明文（以 HPKE 加密後經 mailbox 傳遞，§17.6）。drop 時清除私鑰。
#[derive(Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct DeviceGrantPayload {
    pub v: u8,
    #[zeroize(skip)]
    pub member_id: crate::MemberId,
    #[zeroize(skip)]
    pub account: CafecaAccount,
    /// 本人裝置以 IK 簽發給新裝置的 DeviceCert
    #[zeroize(skip)]
    pub device_cert: Signed<DeviceCert>,
    #[serde(with = "serde_bytes")]
    pub ik_secret: [u8; 32],
    #[serde(with = "serde_bytes")]
    pub ek_secret: [u8; 32],
}

impl std::fmt::Debug for DeviceGrantPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceGrantPayload")
            .field("member_id", &self.member_id)
            .finish_non_exhaustive()
    }
}

impl crate::Versioned for DeviceGrantPayload {
    fn version(&self) -> u8 {
        self.v
    }
}
impl crate::Versioned for CafecaProof {
    fn version(&self) -> u8 {
        self.v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_helpers() {
        let a = CafecaAccount {
            chain_id: 8018,
            address: [0xab; 20],
        };
        assert_eq!(a.address_hex(), format!("0x{}", "ab".repeat(20)));
        assert_eq!(a.caip10(), format!("eip155:8018:0x{}", "ab".repeat(20)));
        assert_eq!(a.short(), "0xabab…abab");
        assert_eq!(
            CafecaAccount::parse_address(&format!("0x{}", "AB".repeat(20))),
            Some([0xab; 20])
        );
        assert_eq!(CafecaAccount::parse_address("0x1234"), None);
        assert_eq!(CafecaAccount::parse_address(&"ab".repeat(20)), None);
    }
}
