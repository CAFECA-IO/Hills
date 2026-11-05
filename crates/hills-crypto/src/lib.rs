//! 對稱金鑰 epoch、HPKE 封裝、加密 change bundle。見 technical-design §2、§4.4。
//!
//! 尚未實作；依 docs/backlog/m0-m1.md 的對應 Issue 開發。

/// 協定 / 資料格式版本，供相容性檢查使用。
pub const FORMAT_VERSION: u8 = 1;

#[cfg(test)]
mod tests {
    #[test]
    fn format_version_is_set() {
        assert_eq!(super::FORMAT_VERSION, 1);
    }
}
