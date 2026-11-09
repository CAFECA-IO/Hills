//! 本機 MCP 介面的組織開關（technical-design §18.2 v0.23，feature-plan D48）。
//!
//! `org.mcp = { allowed: bool }`：只有管理者寫入；不存在 = 不允許。各裝置的本機開關與 token
//! 不在這裡（不同步，由桌機 app 管理）。

use anyhow::{Result, bail};
use automerge::{
    AutoCommit, ObjType, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable,
};

use crate::node::Node;
use crate::org::get_obj;

/// 組織是否允許成員使用 AI 代理（MCP）。
pub fn read_allowed(doc: &AutoCommit) -> bool {
    let Some(o) = get_obj(doc, &ROOT, "mcp") else {
        return false;
    };
    matches!(
        doc.get(&o, "allowed").ok().flatten().map(|v| v.0),
        Some(Value::Scalar(s)) if matches!(s.as_ref(), ScalarValue::Boolean(true))
    )
}

pub fn write_allowed(doc: &mut AutoCommit, allowed: bool) -> Result<()> {
    let o = match get_obj(doc, &ROOT, "mcp") {
        Some(o) => o,
        None => doc.put_object(ROOT, "mcp", ObjType::Map)?,
    };
    doc.put(&o, "allowed", allowed)?;
    Ok(())
}

impl Node {
    pub fn mcp_allowed(&self) -> Result<bool> {
        self.read_doc("org", read_allowed)
    }

    pub async fn set_mcp_allowed(&self, allowed: bool) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以設定是否允許 AI 代理");
        }
        self.change("org", |doc| write_allowed(doc, allowed)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_not_allowed_and_roundtrips() {
        let mut doc = AutoCommit::new();
        assert!(!read_allowed(&doc));
        write_allowed(&mut doc, true).unwrap();
        assert!(read_allowed(&doc));
        write_allowed(&mut doc, false).unwrap();
        assert!(!read_allowed(&doc));
    }
}
