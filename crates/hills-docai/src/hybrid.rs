//! 混合檢索（technical-design §16.21 第 3、4 步，D70）：關鍵字（BM25）與語意（cosine）以 RRF 合併。
//!
//! 段落數在數千以內，BM25 每次查詢時在記憶體中計算，不另存索引。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::chunk::cost;
use crate::index::Passage;
use crate::parse::is_cjk;

/// 段落來源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Item,
    Pdf,
}

/// 參與檢索的一段內容。
pub struct Candidate<'a> {
    pub kind: SourceKind,
    pub passage: Passage<'a>,
}

/// 檢索選項。
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// 取幾段
    pub take: usize,
    /// 同一出處最多幾段
    pub per_source: usize,
    /// 合計長度上限（`chunk::cost` 單位）
    pub budget: f32,
    /// RRF 常數
    pub rrf_k: f32,
    /// 語意相關度門檻：最高 cosine 低於此值且沒有關鍵字命中時視為找不到
    pub min_cosine: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            take: 6,
            per_source: 2,
            budget: 4000.0,
            rrf_k: 60.0,
            min_cosine: 0.80,
        }
    }
}

/// 找到的一段。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: SourceKind,
    pub key: String,
    pub name: String,
    pub heading: Vec<String>,
    pub page_from: u32,
    pub page_to: u32,
    pub text: String,
    pub cosine: f32,
    pub score: f32,
}

/// 檢索結果；`relevant` = 最高 cosine 達門檻或有關鍵字命中。
#[derive(Debug, Clone, PartialEq)]
pub struct Retrieved {
    pub found: Vec<Found>,
    pub relevant: bool,
}

/// 斷詞：拉丁字母與數字以連續字串為一詞（小寫），中日韓字取單字與相鄰兩字。
pub fn terms(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut prev_cjk: Option<char> = None;
    for c in s.chars() {
        if is_cjk(c) {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            out.push(c.to_string());
            if let Some(p) = prev_cjk {
                out.push(format!("{p}{c}"));
            }
            prev_cjk = Some(c);
        } else if c.is_alphanumeric() {
            prev_cjk = None;
            word.extend(c.to_lowercase());
        } else {
            prev_cjk = None;
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// BM25（k1 = 1.2，b = 0.75）。回傳每段的分數（與 `docs` 同順序）。
fn bm25(docs: &[Vec<String>], query: &[String]) -> Vec<f32> {
    let n = docs.len() as f32;
    if docs.is_empty() || query.is_empty() {
        return vec![0.0; docs.len()];
    }
    let avg = docs.iter().map(Vec::len).sum::<usize>() as f32 / n;
    let q: HashSet<&String> = query.iter().collect();
    let mut df: HashMap<&String, f32> = HashMap::new();
    for d in docs {
        let seen: HashSet<&String> = d.iter().filter(|t| q.contains(t)).collect();
        for t in seen {
            *df.entry(t).or_default() += 1.0;
        }
    }
    docs.iter()
        .map(|d| {
            let len = d.len() as f32;
            let mut tf: HashMap<&String, f32> = HashMap::new();
            for t in d.iter().filter(|t| q.contains(t)) {
                *tf.entry(t).or_default() += 1.0;
            }
            tf.iter()
                .map(|(t, f)| {
                    let df = df.get(t).copied().unwrap_or(0.0);
                    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                    idf * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * len / avg.max(1.0)))
                })
                .sum()
        })
        .collect()
}

/// 以多個查詢（文字 + 向量）與關鍵字檢索。
pub fn retrieve(
    candidates: &[Candidate<'_>],
    queries: &[(String, Vec<f32>)],
    keywords: &[String],
    opt: &Options,
) -> Retrieved {
    if candidates.is_empty() {
        return Retrieved {
            found: Vec::new(),
            relevant: false,
        };
    }
    let docs: Vec<Vec<String>> = candidates
        .iter()
        .map(|c| terms(&c.passage.chunk.embed_text()))
        .collect();
    let mut rrf = vec![0.0_f32; candidates.len()];
    let mut best_cos = vec![f32::MIN; candidates.len()];
    let mut keyword_hit = false;
    let rank_into = |scores: &[f32], rrf: &mut [f32]| {
        let mut order: Vec<usize> = (0..scores.len()).filter(|&i| scores[i] > 0.0).collect();
        order.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]));
        for (rank, i) in order.into_iter().enumerate() {
            rrf[i] += 1.0 / (opt.rrf_k + rank as f32 + 1.0);
        }
    };
    for (text, vec) in queries {
        let cos: Vec<f32> = candidates
            .iter()
            .map(|c| {
                if c.passage.vec.len() == vec.len() {
                    c.passage.vec.iter().zip(vec).map(|(a, b)| a * b).sum()
                } else {
                    0.0
                }
            })
            .collect();
        for (b, c) in best_cos.iter_mut().zip(&cos) {
            *b = b.max(*c);
        }
        // cosine 可能為負：排名用 cosine + 1
        let shifted: Vec<f32> = cos.iter().map(|c| c + 1.0).collect();
        rank_into(&shifted, &mut rrf);
        let mut q = terms(text);
        q.extend(keywords.iter().flat_map(|k| terms(k)));
        rank_into(&bm25(&docs, &q), &mut rrf);
    }
    // 關鍵字命中：任一個（長度 ≥ 2 的）關鍵字原文出現在段落中
    let kws: Vec<String> = keywords
        .iter()
        .map(|k| k.trim().to_lowercase())
        .filter(|k| k.chars().count() >= 2)
        .collect();
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&a, &b| rrf[b].total_cmp(&rrf[a]));
    let mut per: HashMap<(SourceKind, &str), usize> = HashMap::new();
    let mut used = 0.0;
    let mut found = Vec::new();
    for i in order {
        if found.len() >= opt.take {
            break;
        }
        let c = &candidates[i];
        let n = per.entry((c.kind, c.passage.key)).or_insert(0);
        if *n >= opt.per_source {
            continue;
        }
        let len = cost(&c.passage.chunk.text);
        if !found.is_empty() && used + len > opt.budget {
            continue;
        }
        *n += 1;
        used += len;
        let hay = c.passage.chunk.embed_text().to_lowercase();
        if kws.iter().any(|k| hay.contains(k.as_str())) {
            keyword_hit = true;
        }
        found.push(Found {
            kind: c.kind,
            key: c.passage.key.to_owned(),
            name: c.passage.name.to_owned(),
            heading: c.passage.chunk.heading.clone(),
            page_from: c.passage.chunk.page_from,
            page_to: c.passage.chunk.page_to,
            text: c.passage.chunk.text.clone(),
            cosine: best_cos[i],
            score: rrf[i],
        });
    }
    let top_cos = found.iter().map(|f| f.cosine).fold(f32::MIN, f32::max);
    Retrieved {
        relevant: !found.is_empty() && (top_cos >= opt.min_cosine || keyword_hit),
        found,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Chunk;

    fn chunk(text: &str) -> Chunk {
        Chunk {
            page_from: 1,
            page_to: 1,
            heading: vec!["部署".into()],
            text: text.into(),
        }
    }

    #[test]
    fn terms_mix_cjk_and_latin() {
        assert_eq!(
            terms("relay 斷線 UDP7842"),
            ["relay", "斷", "線", "斷線", "udp7842"]
        );
    }

    #[test]
    fn keyword_and_vector_ranks_merge() {
        let a = chunk("relay 斷線時訊息先存在 mailbox，重新連上後補同步。");
        let b = chunk("焦點山配色使用晴空藍。");
        let c = chunk("特休依到職日計算。");
        let va = [1.0, 0.0];
        let vb = [0.0, 1.0];
        let vc = [0.6, 0.8];
        let cands = vec![
            Candidate {
                kind: SourceKind::Item,
                passage: Passage {
                    key: "k:a",
                    name: "mailbox 補同步",
                    chunk: &a,
                    vec: &va,
                },
            },
            Candidate {
                kind: SourceKind::Item,
                passage: Passage {
                    key: "k:b",
                    name: "配色",
                    chunk: &b,
                    vec: &vb,
                },
            },
            Candidate {
                kind: SourceKind::Pdf,
                passage: Passage {
                    key: "f:c",
                    name: "手冊.pdf",
                    chunk: &c,
                    vec: &vc,
                },
            },
        ];
        let r = retrieve(
            &cands,
            &[("relay 斷線".into(), vec![0.9, 0.1])],
            &["mailbox".into()],
            &Options::default(),
        );
        assert!(r.relevant);
        assert_eq!(r.found[0].key, "k:a");
        // 沒有關鍵字、語意也不夠接近 → 找不到
        let r = retrieve(
            &cands,
            &[("年終獎金".into(), vec![0.5, 0.5])],
            &["年終獎金".into()],
            &Options::default(),
        );
        assert!(!r.relevant);
    }

    #[test]
    fn per_source_cap() {
        let a = chunk("relay 一");
        let b = chunk("relay 二");
        let c = chunk("relay 三");
        let v = [1.0, 0.0];
        let cands: Vec<Candidate<'_>> = [&a, &b, &c]
            .into_iter()
            .map(|ch| Candidate {
                kind: SourceKind::Item,
                passage: Passage {
                    key: "same",
                    name: "n",
                    chunk: ch,
                    vec: &v,
                },
            })
            .collect();
        let r = retrieve(
            &cands,
            &[("relay".into(), vec![1.0, 0.0])],
            &[],
            &Options::default(),
        );
        assert_eq!(r.found.len(), 2);
    }
}
