//! PoC：Automerge 離線編輯與同步驗證（technical-design §12、Issue「[M0][PoC] Automerge 離線編輯與同步驗證」）。
//!
//! 以「計劃文件」的結構（technical-design §8 的 PlanItem / KeyResult）建立文件，兩個副本各自離線
//! 編輯 N 次，再透過 Automerge sync protocol 交換編碼後的訊息，量測：
//! - 合併是否一致（heads 與內容）
//! - 同步耗時、往返次數、傳輸位元組
//! - 文件儲存大小
//!
//! ```text
//! cargo run --release -p automerge-sync -- 100
//! ```

use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use automerge::{
    AutoCommit, AutoSerde, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value,
    sync::{Message, State, SyncDoc},
    transaction::Transactable,
};
use serde_json::json;

/// 建立含年度 OKR 與數個月 / 週項目的計劃文件。
fn base_document() -> Result<AutoCommit> {
    let mut doc = AutoCommit::new();
    let items = doc.put_object(ROOT, "items", ObjType::List)?;
    let year = doc.insert_object(&items, 0, ObjType::Map)?;
    doc.put(&year, "id", "01HY0000000000000000000000")?;
    doc.put(&year, "level", "year")?;
    doc.put(&year, "period", "2026")?;
    doc.put(&year, "title", "完成 Hills MVP")?;
    let krs = doc.put_object(&year, "keyResults", ObjType::List)?;
    for (i, title) in ["M0 驗收通過", "M1 功能完成"].iter().enumerate() {
        let kr = doc.insert_object(&krs, i, ObjType::Map)?;
        doc.put(&kr, "title", *title)?;
        doc.put(&kr, "start", 0)?;
        doc.put(&kr, "target", 100)?;
        doc.put(&kr, "current", 0)?;
    }
    Ok(doc)
}

fn items(doc: &AutoCommit) -> Result<ObjId> {
    match doc.get(ROOT, "items")? {
        Some((Value::Object(ObjType::List), id)) => Ok(id),
        _ => bail!("缺少 items"),
    }
}

fn first_kr(doc: &AutoCommit, which: usize) -> Result<ObjId> {
    let items = items(doc)?;
    let Some((_, year)) = doc.get(&items, 0)? else {
        bail!("缺少年度項目")
    };
    let Some((_, krs)) = doc.get(&year, "keyResults")? else {
        bail!("缺少 KR")
    };
    let Some((_, kr)) = doc.get(&krs, which)? else {
        bail!("缺少 KR {which}")
    };
    Ok(kr)
}

/// 模擬一位成員離線時的編輯：新增週 / 日項目、修改標題、勾選完成、更新 KR 數值。
fn offline_edits(doc: &mut AutoCommit, who: &str, n: usize) -> Result<()> {
    for i in 0..n {
        let items = items(doc)?;
        match i % 4 {
            0 => {
                let len = doc.length(&items);
                let it = doc.insert_object(&items, len, ObjType::Map)?;
                doc.put(&it, "id", format!("{who}-{i:04}"))?;
                doc.put(&it, "level", if i % 8 == 0 { "week" } else { "day" })?;
                doc.put(&it, "parentId", "01HY0000000000000000000000")?;
                doc.put(&it, "title", format!("{who} 的工作項目 {i}"))?;
                doc.put(&it, "done", false)?;
            }
            1 => {
                let len = doc.length(&items);
                if len > 1 {
                    let Some((_, it)) = doc.get(&items, len - 1)? else {
                        continue;
                    };
                    doc.put(&it, "title", format!("{who} 修改標題 {i}"))?;
                }
            }
            2 => {
                let len = doc.length(&items);
                if len > 1 {
                    let Some((_, it)) = doc.get(&items, len - 1)? else {
                        continue;
                    };
                    doc.put(&it, "done", true)?;
                }
            }
            _ => {
                // 兩人同時修改同一個 KR：Automerge 以確定性規則選出勝者，雙方結果必須一致
                let kr = first_kr(doc, 0)?;
                doc.put(&kr, "current", ScalarValue::Int(i as i64))?;
            }
        }
        doc.commit();
    }
    Ok(())
}

#[derive(Debug)]
struct SyncStats {
    rounds: usize,
    bytes: usize,
    elapsed: Duration,
}

/// 以編碼後的 sync 訊息來回交換，直到雙方都沒有訊息要送。
fn sync_pair(a: &mut AutoCommit, b: &mut AutoCommit) -> Result<SyncStats> {
    let (mut sa, mut sb) = (State::new(), State::new());
    let (mut rounds, mut bytes) = (0, 0);
    let t = Instant::now();
    loop {
        let mut progressed = false;
        if let Some(msg) = a.sync().generate_sync_message(&mut sa) {
            let enc = msg.encode();
            bytes += enc.len();
            b.sync()
                .receive_sync_message(&mut sb, Message::decode(&enc)?)?;
            progressed = true;
        }
        if let Some(msg) = b.sync().generate_sync_message(&mut sb) {
            let enc = msg.encode();
            bytes += enc.len();
            a.sync()
                .receive_sync_message(&mut sa, Message::decode(&enc)?)?;
            progressed = true;
        }
        if !progressed {
            break;
        }
        rounds += 1;
        if rounds > 1000 {
            bail!("同步未收斂");
        }
    }
    Ok(SyncStats {
        rounds,
        bytes,
        elapsed: t.elapsed(),
    })
}

fn snapshot(doc: &AutoCommit) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(AutoSerde::from(doc))?)
}

struct Outcome {
    stats: SyncStats,
    a: AutoCommit,
    b: AutoCommit,
}

fn run(edits: usize) -> Result<Outcome> {
    let mut base = base_document()?;
    let mut a = base.fork();
    let mut b = base.fork();
    offline_edits(&mut a, "alice", edits)?;
    offline_edits(&mut b, "bob", edits)?;
    let stats = sync_pair(&mut a, &mut b)?;
    Ok(Outcome { stats, a, b })
}

fn main() -> Result<()> {
    let edits = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    let mut o = run(edits)?;
    let (ha, hb) = (o.a.get_heads(), o.b.get_heads());
    let consistent = ha == hb && snapshot(&o.a)? == snapshot(&o.b)?;
    let saved = o.a.save();
    println!(
        "{}",
        json!({
            "edits_per_replica": edits,
            "consistent": consistent,
            "sync_ms": o.stats.elapsed.as_secs_f64() * 1000.0,
            "sync_rounds": o.stats.rounds,
            "sync_bytes": o.stats.bytes,
            "saved_bytes": saved.len(),
            "items": o.a.length(items(&o.a)?),
        })
    );
    if !consistent {
        bail!("合併結果不一致");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hundred_offline_edits_each_merge_consistently() {
        let mut o = run(100).unwrap();
        assert_eq!(o.a.get_heads(), o.b.get_heads());
        assert_eq!(snapshot(&o.a).unwrap(), snapshot(&o.b).unwrap());
        // 年度項目 + 雙方各新增 25 個項目
        assert_eq!(o.a.length(items(&o.a).unwrap()), 1 + 25 * 2);
        // technical-design §12 通過標準：合併 < 1 秒
        assert!(o.stats.elapsed < Duration::from_secs(1), "{:?}", o.stats);
    }

    #[test]
    fn concurrent_kr_update_resolves_identically() {
        let o = run(8).unwrap();
        let va =
            o.a.get(first_kr(&o.a, 0).unwrap(), "current")
                .unwrap()
                .map(|v| v.0.to_string());
        let vb =
            o.b.get(first_kr(&o.b, 0).unwrap(), "current")
                .unwrap()
                .map(|v| v.0.to_string());
        assert_eq!(va, vb);
    }

    #[test]
    fn saved_document_reloads() {
        let mut o = run(20).unwrap();
        let bytes = o.a.save();
        let reloaded = AutoCommit::load(&bytes).unwrap();
        assert_eq!(snapshot(&reloaded).unwrap(), snapshot(&o.a).unwrap());
    }
}
