//! Markdown 區塊 → 檢索用的段落（technical-design §16.20「切片」）。純函式。

use serde::{Deserialize, Serialize};

use crate::parse::is_cjk;

/// 解析結果的區塊。`Formula`、`Table`、`Figure` 由第二階段產生，切片時不切開。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Block {
    Heading {
        level: u8,
        text: String,
        page: u32,
    },
    Para {
        text: String,
        page: u32,
    },
    Formula {
        latex: String,
        display: bool,
        page: u32,
    },
    Table {
        markdown: String,
        page: u32,
    },
    Figure {
        caption: String,
        page: u32,
    },
}

impl Block {
    pub fn page(&self) -> u32 {
        match self {
            Block::Heading { page, .. }
            | Block::Para { page, .. }
            | Block::Formula { page, .. }
            | Block::Table { page, .. }
            | Block::Figure { page, .. } => *page,
        }
    }
}

/// 一段可檢索的內容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chunk {
    pub page_from: u32,
    pub page_to: u32,
    /// 標題路徑（由大到小）
    pub heading: Vec<String>,
    /// 段落本文（不含標題路徑）
    pub text: String,
}

impl Chunk {
    /// 向量化用的文字：標題路徑 + 本文。
    pub fn embed_text(&self) -> String {
        if self.heading.is_empty() {
            self.text.clone()
        } else {
            format!("{}\n{}", self.heading.join(" › "), self.text)
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// 每段上限（單位）
    pub max: f32,
    /// 與上一段重疊的長度（單位）
    pub overlap: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max: 900.0,
            overlap: 135.0,
        }
    }
}

/// 中日韓字 1.5 單位，其他字元 1 單位。
pub fn cost(s: &str) -> f32 {
    s.chars()
        .filter(|c| !c.is_whitespace() || *c == ' ')
        .map(|c| if is_cjk(c) { 1.5 } else { 1.0 })
        .sum()
}

#[derive(Debug, Clone)]
struct Unit {
    text: String,
    page: u32,
    /// 公式、表格、圖：不切開，也不拿來重疊
    atomic: bool,
}

/// 依標題分段，再依長度切片；相鄰段落重疊，重疊不跨標題。
pub fn chunk_blocks(blocks: &[Block], opt: &Options) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut path: Vec<(u8, String)> = Vec::new();
    let mut units: Vec<Unit> = Vec::new();

    for b in blocks {
        match b {
            Block::Heading { level, text, .. } => {
                emit_section(&mut out, &heading_of(&path), &units, opt);
                units.clear();
                path.retain(|(l, _)| *l < *level);
                path.push((*level, text.clone()));
            }
            Block::Para { text, page } => {
                if cost(text) <= opt.max {
                    units.push(Unit {
                        text: text.clone(),
                        page: *page,
                        atomic: false,
                    });
                } else {
                    for s in pack_sentences(&sentences(text), opt.max) {
                        units.push(Unit {
                            text: s,
                            page: *page,
                            atomic: false,
                        });
                    }
                }
            }
            Block::Formula {
                latex,
                display,
                page,
            } => units.push(Unit {
                text: if *display {
                    format!("$${latex}$$")
                } else {
                    format!("${latex}$")
                },
                page: *page,
                atomic: true,
            }),
            Block::Table { markdown, page } => units.push(Unit {
                text: markdown.clone(),
                page: *page,
                atomic: true,
            }),
            Block::Figure { caption, page } => units.push(Unit {
                text: format!("> 圖（第 {page} 頁）：{caption}"),
                page: *page,
                atomic: true,
            }),
        }
    }
    emit_section(&mut out, &heading_of(&path), &units, opt);
    out
}

fn heading_of(path: &[(u8, String)]) -> Vec<String> {
    path.iter().map(|(_, t)| t.clone()).collect()
}

/// 一個標題底下的內容切成數段。
fn emit_section(out: &mut Vec<Chunk>, heading: &[String], units: &[Unit], opt: &Options) {
    // 只有標題的章節不建立段落（標題會出現在下一節的路徑中）
    if units.is_empty() {
        return;
    }
    let mut cur: Vec<Unit> = Vec::new();
    let mut cur_cost = 0.0;
    let mut has_new = false;
    for u in units {
        let c = cost(&u.text);
        if has_new && cur_cost + c > opt.max {
            out.push(make(heading, &cur));
            let tail = overlap_tail(&cur, opt.overlap);
            let tail_cost: f32 = tail.iter().map(|t| cost(&t.text)).sum();
            // 加上重疊會超過上限時（下一個區塊很長）就不重疊
            (cur, cur_cost) = if tail_cost + c > opt.max {
                (Vec::new(), 0.0)
            } else {
                (tail, tail_cost)
            };
        }
        cur_cost += c;
        cur.push(u.clone());
        has_new = true;
    }
    if has_new {
        out.push(make(heading, &cur));
    }
}

fn make(heading: &[String], units: &[Unit]) -> Chunk {
    Chunk {
        page_from: units.iter().map(|u| u.page).min().unwrap_or(0),
        page_to: units.iter().map(|u| u.page).max().unwrap_or(0),
        heading: heading.to_vec(),
        text: units
            .iter()
            .map(|u| u.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

/// 從上一段最後面取句子，總長不超過 `budget`；遇到公式、表格、圖就停。
fn overlap_tail(units: &[Unit], budget: f32) -> Vec<Unit> {
    let mut picked: Vec<String> = Vec::new();
    let mut used = 0.0;
    let Some(last) = units.last() else {
        return Vec::new();
    };
    if last.atomic {
        return Vec::new();
    }
    for s in sentences(&last.text).into_iter().rev() {
        let c = cost(&s);
        if used + c > budget {
            break;
        }
        used += c;
        picked.push(s);
    }
    if picked.is_empty() {
        return Vec::new();
    }
    picked.reverse();
    vec![Unit {
        text: join_sentences(&picked),
        page: last.page,
        atomic: false,
    }]
}

/// 在句號、問號、驚嘆號、分號或換行處切開（標點留在前一句）。
pub fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\n' {
            push_trim(&mut out, &mut cur);
            continue;
        }
        cur.push(c);
        let end = matches!(c, '。' | '！' | '？' | '；')
            || (matches!(c, '.' | '!' | '?' | ';') && it.peek().is_none_or(|n| n.is_whitespace()));
        if end {
            push_trim(&mut out, &mut cur);
        }
    }
    push_trim(&mut out, &mut cur);
    out
}

fn push_trim(out: &mut Vec<String>, cur: &mut String) {
    let t = cur.trim();
    if !t.is_empty() {
        out.push(t.to_owned());
    }
    cur.clear();
}

fn join_sentences(s: &[String]) -> String {
    let mut out = String::new();
    for x in s {
        let need_space = matches!(
            (out.chars().last(), x.chars().next()),
            (Some(a), Some(b)) if !(is_cjk(a) && is_cjk(b)) && !is_cjk(a)
        );
        if need_space {
            out.push(' ');
        }
        out.push_str(x);
    }
    out
}

/// 句子組成不超過 `max` 的片段；單句超過上限時硬切。
fn pack_sentences(sents: &[String], max: f32) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut used = 0.0;
    for s in sents {
        for piece in hard_split(s, max) {
            let c = cost(&piece);
            if !cur.is_empty() && used + c > max {
                out.push(join_sentences(&cur));
                cur.clear();
                used = 0.0;
            }
            used += c;
            cur.push(piece);
        }
    }
    if !cur.is_empty() {
        out.push(join_sentences(&cur));
    }
    out
}

fn hard_split(s: &str, max: f32) -> Vec<String> {
    if cost(s) <= max {
        return vec![s.to_owned()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut used = 0.0;
    for c in s.chars() {
        let w = if is_cjk(c) { 1.5 } else { 1.0 };
        if used + w > max {
            out.push(std::mem::take(&mut cur));
            used = 0.0;
        }
        cur.push(c);
        used += w;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(t: &str, page: u32) -> Block {
        Block::Para {
            text: t.into(),
            page,
        }
    }
    fn h(level: u8, t: &str) -> Block {
        Block::Heading {
            level,
            text: t.into(),
            page: 1,
        }
    }

    #[test]
    fn counts_units() {
        assert_eq!(cost("ab"), 2.0);
        assert_eq!(cost("請假"), 3.0);
        assert_eq!(cost("a 請"), 3.5);
    }

    #[test]
    fn splits_sentences() {
        assert_eq!(
            sentences("第一句。第二句！Third one. 3.14 is pi? end"),
            vec!["第一句。", "第二句！", "Third one.", "3.14 is pi?", "end"]
        );
    }

    #[test]
    fn keeps_heading_path_and_resets_on_new_heading() {
        let blocks = vec![
            h(1, "第 3 章"),
            h(2, "3.1 方法"),
            para("內容一。", 2),
            h(2, "3.2 結果"),
            para("內容二。", 3),
            h(1, "第 4 章"),
            para("內容三。", 4),
        ];
        let c = chunk_blocks(&blocks, &Options::default());
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].heading, vec!["第 3 章", "3.1 方法"]);
        assert_eq!(c[1].heading, vec!["第 3 章", "3.2 結果"]);
        assert_eq!(c[2].heading, vec!["第 4 章"]);
        assert_eq!(c[2].page_from, 4);
        assert_eq!(c[0].embed_text(), "第 3 章 › 3.1 方法\n內容一。");
    }

    #[test]
    fn respects_max_and_overlaps() {
        let opt = Options {
            max: 60.0,
            overlap: 20.0,
        };
        // 每段 10 字 = 15 單位
        let blocks: Vec<Block> = (0..8)
            .map(|i| para(&format!("這是第{i}段的內容。"), i + 1))
            .collect();
        let c = chunk_blocks(&blocks, &opt);
        assert!(c.len() >= 3);
        for x in &c {
            assert!(cost(&x.text.replace("\n\n", "")) <= opt.max, "{x:?}");
        }
        // 下一段開頭是上一段的最後一句
        let last_of_first = c[0].text.rsplit("\n\n").next().unwrap_or_default();
        assert!(c[1].text.starts_with(last_of_first));
        // 頁碼範圍涵蓋重疊的頁
        assert_eq!(c[1].page_from, c[0].page_to);
    }

    #[test]
    fn never_splits_formula_or_table() {
        let opt = Options {
            max: 30.0,
            overlap: 10.0,
        };
        let table = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
        let blocks = vec![
            para("前言。", 1),
            Block::Formula {
                latex: r"E = mc^2 + \sum_{i=1}^{n} x_i".into(),
                display: true,
                page: 1,
            },
            Block::Table {
                markdown: table.into(),
                page: 2,
            },
            para("結語。", 2),
        ];
        let c = chunk_blocks(&blocks, &opt);
        assert!(
            c.iter()
                .any(|x| x.text.contains(r"$$E = mc^2 + \sum_{i=1}^{n} x_i$$"))
        );
        assert!(c.iter().any(|x| x.text.contains(table)));
        // 公式或表格結尾時，下一段不帶重疊
        let after_table = c.iter().position(|x| x.text.contains(table)).unwrap_or(0);
        if let Some(n) = c.get(after_table + 1) {
            assert!(!n.text.contains("| a |"));
        }
    }

    #[test]
    fn splits_very_long_paragraph() {
        let opt = Options {
            max: 40.0,
            overlap: 0.0,
        };
        let long = "一二三四五六七八九十。".repeat(10);
        let c = chunk_blocks(&[para(&long, 1)], &opt);
        assert!(c.len() >= 4);
        assert!(c.iter().all(|x| cost(&x.text) <= 40.0));
        let joined: String = c.iter().map(|x| x.text.as_str()).collect();
        assert_eq!(joined, long);
    }

    #[test]
    fn figure_caption_is_one_unit() {
        let c = chunk_blocks(
            &[Block::Figure {
                caption: "長條圖顯示三月營收最高".into(),
                page: 5,
            }],
            &Options::default(),
        );
        assert_eq!(c[0].text, "> 圖（第 5 頁）：長條圖顯示三月營收最高");
    }
}
