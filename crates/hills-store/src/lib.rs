//! 本地儲存：Automerge 文件庫（靜態加密）與 SQLite 投影。見 technical-design §9。
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
