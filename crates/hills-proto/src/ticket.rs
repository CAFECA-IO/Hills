//! 文字碼：邀請碼、組織連線碼、mailbox 連線碼、裝置綁定碼（technical-design §16.2–16.4、§16.9）。
//!
//! 格式：`<prefix>` + 小寫 base32（無補齊）of postcard。

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{FORMAT_VERSION, PeerAddr, ProtoError, Pub32, Versioned, check_version};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteTicket {
    pub v: u8,
    pub org_root: Pub32,
    pub invite_id: [u8; 8],
    pub secret: [u8; 16],
    pub mailbox: PeerAddr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgTicket {
    pub v: u8,
    pub org_root: Pub32,
    pub mailbox: PeerAddr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxTicket {
    pub v: u8,
    pub mailbox: PeerAddr,
}

/// 儲存節點連線碼（technical-design §15.6 v0.12）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageTicket {
    pub v: u8,
    pub index: u8,
    pub node: PeerAddr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkTicket {
    pub v: u8,
    pub device: PeerAddr,
    pub eph_pub: Pub32,
}

impl Versioned for InviteTicket {
    fn version(&self) -> u8 {
        self.v
    }
}
impl Versioned for OrgTicket {
    fn version(&self) -> u8 {
        self.v
    }
}
impl Versioned for MailboxTicket {
    fn version(&self) -> u8 {
        self.v
    }
}
impl Versioned for StorageTicket {
    fn version(&self) -> u8 {
        self.v
    }
}
impl Versioned for LinkTicket {
    fn version(&self) -> u8 {
        self.v
    }
}

pub trait Ticket: Serialize + DeserializeOwned + Versioned {
    const PREFIX: &'static str;

    fn to_code(&self) -> Result<String, ProtoError> {
        let bytes = postcard::to_allocvec(self).map_err(|_| ProtoError::Encode)?;
        Ok(format!(
            "{}{}",
            Self::PREFIX,
            data_encoding::BASE32_NOPAD
                .encode(&bytes)
                .to_ascii_lowercase()
        ))
    }

    /// 解析文字碼；容許前後空白與換行（貼上時常見）。
    fn from_code(code: &str) -> Result<Self, ProtoError> {
        let compact: String = code.split_whitespace().collect();
        let body = compact
            .strip_prefix(Self::PREFIX)
            .ok_or(ProtoError::Invalid("前綴不符"))?;
        let bytes = data_encoding::BASE32_NOPAD
            .decode(body.to_ascii_uppercase().as_bytes())
            .map_err(|_| ProtoError::Invalid("編碼錯誤"))?;
        let t: Self = postcard::from_bytes(&bytes).map_err(|_| ProtoError::Decode)?;
        check_version(t.version())?;
        Ok(t)
    }
}

impl Ticket for InviteTicket {
    const PREFIX: &'static str = "hills1-";
}
impl Ticket for OrgTicket {
    const PREFIX: &'static str = "hills-org1-";
}
impl Ticket for MailboxTicket {
    const PREFIX: &'static str = "hills-mbx1-";
}
impl Ticket for StorageTicket {
    const PREFIX: &'static str = "hills-sto1-";
}
impl Ticket for LinkTicket {
    const PREFIX: &'static str = "hills-link1-";
}

impl MailboxTicket {
    pub fn new(mailbox: PeerAddr) -> Self {
        Self {
            v: FORMAT_VERSION,
            mailbox,
        }
    }
}

impl StorageTicket {
    pub fn new(index: u8, node: PeerAddr) -> Self {
        Self {
            v: FORMAT_VERSION,
            index,
            node,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_ticket_roundtrip() {
        let t = StorageTicket::new(3, addr());
        let code = t.to_code().unwrap();
        assert!(code.starts_with("hills-sto1-"));
        assert_eq!(StorageTicket::from_code(&code).unwrap(), t);
    }

    fn addr() -> PeerAddr {
        PeerAddr {
            node: Pub32([7; 32]),
            relay: Some("https://relay.example.com".into()),
            direct: vec!["203.0.113.5:7843".into()],
        }
    }

    #[test]
    fn invite_roundtrip_and_whitespace() {
        let t = InviteTicket {
            v: FORMAT_VERSION,
            org_root: Pub32([1; 32]),
            invite_id: [2; 8],
            secret: [3; 16],
            mailbox: addr(),
        };
        let code = t.to_code().unwrap();
        assert!(code.starts_with("hills1-"));
        let wrapped = format!("  {}\n{}  ", &code[..20], &code[20..]);
        assert_eq!(InviteTicket::from_code(&wrapped).unwrap(), t);
    }

    #[test]
    fn wrong_prefix_or_garbage_rejected() {
        let t = OrgTicket {
            v: FORMAT_VERSION,
            org_root: Pub32([1; 32]),
            mailbox: addr(),
        };
        let code = t.to_code().unwrap();
        assert!(InviteTicket::from_code(&code).is_err());
        assert!(OrgTicket::from_code("hills-org1-!!!").is_err());
        assert!(OrgTicket::from_code("hills-org1-aaaa").is_err());
    }
}
