//! PDF 文字層 → 行 → Markdown 區塊（technical-design §16.20「解析」）。
//!
//! 讀 pdfium 的部分只負責把每頁的字元整理成行（[`read_pdf`]）；
//! 合併段落、判斷標題的規則是純函式（[`lines_to_blocks`]），可以不靠 pdfium 測試。

use pdfium_render::prelude::*;

use crate::chunk::Block;
use crate::{DocAiError, MAX_PAGES, Result};

/// 一行文字與其版面資訊（PDF 座標，y 向上）。
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub text: String,
    /// 字級（點）
    pub size: f32,
    pub bold: bool,
    pub top: f32,
    pub bottom: f32,
}

#[derive(Debug, Clone, Default)]
pub struct PageLines {
    /// 頁碼，從 1 開始
    pub page: u32,
    pub lines: Vec<Line>,
    /// 文字極少但有圖片：可能是掃描頁，交給第二階段
    pub needs_ocr: bool,
}

/// 讀出每頁的行。
pub fn read_pdf(pdfium: &Pdfium, bytes: &[u8]) -> Result<Vec<PageLines>> {
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|_| DocAiError::BadPdf)?;
    let pages = doc.pages();
    if pages.len() > MAX_PAGES {
        return Err(DocAiError::TooLarge);
    }
    let mut out = Vec::new();
    for (i, page) in pages.iter().enumerate() {
        let n = u32::try_from(i + 1).unwrap_or(u32::MAX);
        let text = page.text().map_err(|_| DocAiError::BadPdf)?;
        let mut lines = Vec::new();
        let mut cur = LineAcc::default();
        for ch in text.chars().iter() {
            let Some(c) = ch.unicode_char() else { continue };
            if c == '\r' || c == '\n' {
                cur.finish(&mut lines);
                continue;
            }
            if c.is_whitespace() || c.is_control() {
                cur.push_space();
                continue;
            }
            let size = ch.scaled_font_size().value;
            let bold = ch.font_is_bold_reenforced()
                || matches!(
                    ch.font_weight(),
                    Some(
                        PdfFontWeight::Weight600
                            | PdfFontWeight::Weight700Bold
                            | PdfFontWeight::Weight800
                            | PdfFontWeight::Weight900
                    )
                )
                || matches!(ch.font_weight(), Some(PdfFontWeight::Custom(w)) if w >= 600);
            let (top, bottom) = ch
                .loose_bounds()
                .map(|r| (r.top().value, r.bottom().value))
                .unwrap_or((0.0, 0.0));
            cur.push(c, size, bold, top, bottom);
        }
        cur.finish(&mut lines);
        let chars: usize = lines.iter().map(|l: &Line| l.text.chars().count()).sum();
        let has_image = page
            .objects()
            .iter()
            .any(|o| o.object_type() == PdfPageObjectType::Image);
        out.push(PageLines {
            page: n,
            needs_ocr: chars < 20 && has_image,
            lines,
        });
    }
    Ok(out)
}

#[derive(Default)]
struct LineAcc {
    text: String,
    sizes: Vec<f32>,
    bold: usize,
    top: f32,
    bottom: f32,
    pending_space: bool,
}

impl LineAcc {
    fn push_space(&mut self) {
        if !self.text.is_empty() {
            self.pending_space = true;
        }
    }

    fn push(&mut self, c: char, size: f32, bold: bool, top: f32, bottom: f32) {
        if self.pending_space {
            self.text.push(' ');
            self.pending_space = false;
        }
        if self.sizes.is_empty() {
            self.top = top;
            self.bottom = bottom;
        } else {
            self.top = self.top.max(top);
            self.bottom = self.bottom.min(bottom);
        }
        self.text.push(c);
        self.sizes.push(size);
        if bold {
            self.bold += 1;
        }
    }

    fn finish(&mut self, out: &mut Vec<Line>) {
        let acc = std::mem::take(self);
        if acc.sizes.is_empty() {
            return;
        }
        out.push(Line {
            text: acc.text,
            size: median(&acc.sizes),
            bold: acc.bold * 2 > acc.sizes.len(),
            top: acc.top,
            bottom: acc.bottom,
        });
    }
}

fn median(v: &[f32]) -> f32 {
    let mut s: Vec<f32> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return 0.0;
    }
    s.sort_by(f32::total_cmp);
    s[s.len() / 2]
}

/// 中日韓文字（含全形標點）。
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F   // CJK 標點
        | 0x3040..=0x30FF // 平假名、片假名
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xAC00..=0xD7AF // 韓文
        | 0xF900..=0xFAFF
        | 0xFF00..=0xFFEF // 全形
        | 0x20000..=0x2FFFF)
}

const HEADING_RATIO: f32 = 1.2;
const HEADING_MAX_CHARS: usize = 80;
const PARA_GAP: f32 = 1.6;

/// 行 → 區塊：段落合併、標題判斷（technical-design §16.20）。
pub fn lines_to_blocks(pages: &[PageLines]) -> Vec<Block> {
    // 本文字級 = 全文件字元數加權的中位數
    let mut weighted: Vec<(f32, usize)> = pages
        .iter()
        .flat_map(|p| p.lines.iter())
        .map(|l| (l.size, l.text.chars().count()))
        .collect();
    weighted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: usize = weighted.iter().map(|w| w.1).sum();
    let mut body = 0.0;
    let mut acc = 0;
    for (s, n) in &weighted {
        acc += n;
        if acc * 2 >= total {
            body = *s;
            break;
        }
    }
    // 標題字級由大到小排名 → # / ## / ###
    let mut heading_sizes: Vec<f32> = pages
        .iter()
        .flat_map(|p| p.lines.iter())
        .filter(|l| is_heading(l, body))
        .map(|l| (l.size * 2.0).round() / 2.0)
        .collect();
    heading_sizes.sort_by(|a, b| b.total_cmp(a));
    heading_sizes.dedup();
    let level_of = |size: f32| {
        let r = (size * 2.0).round() / 2.0;
        let i = heading_sizes.iter().position(|s| *s <= r).unwrap_or(0);
        u8::try_from(i.min(2) + 1).unwrap_or(3)
    };

    let mut out = Vec::new();
    for p in pages {
        let mut para: Option<(String, &Line)> = None;
        for l in &p.lines {
            let text = l.text.trim();
            if text.is_empty() {
                continue;
            }
            if is_heading(l, body) {
                flush(&mut out, &mut para, p.page);
                out.push(Block::Heading {
                    level: level_of(l.size),
                    text: text.to_owned(),
                    page: p.page,
                });
                continue;
            }
            match &mut para {
                Some((buf, prev)) if continues(prev, l) => {
                    join_line(buf, text);
                    *prev = l;
                }
                _ => {
                    flush(&mut out, &mut para, p.page);
                    para = Some((text.to_owned(), l));
                }
            }
        }
        flush(&mut out, &mut para, p.page);
    }
    out
}

fn is_heading(l: &Line, body: f32) -> bool {
    let n = l.text.trim().chars().count();
    n > 0
        && n <= HEADING_MAX_CHARS
        && body > 0.0
        && l.size >= body * HEADING_RATIO
        && !l.text.trim().ends_with(['。', '.', '，', ','])
}

/// 下一行是否接在同一段：行距不超過行高的 1.6 倍、字級相近。
fn continues(prev: &Line, next: &Line) -> bool {
    let h = (prev.top - prev.bottom).abs().max(prev.size).max(1.0);
    let gap = prev.bottom - next.top;
    let similar = (prev.size - next.size).abs() <= prev.size.max(1.0) * 0.15;
    similar && gap <= h * (PARA_GAP - 1.0) && gap > -h
}

fn join_line(buf: &mut String, next: &str) {
    let last = buf.chars().last();
    let first = next.chars().next();
    match (last, first) {
        (Some('-'), Some(f)) if f.is_lowercase() => {
            buf.pop();
        }
        (Some(a), Some(b)) if is_cjk(a) && is_cjk(b) => {}
        (Some(a), _) if is_cjk(a) && matches!(first, Some(b) if is_cjk(b)) => {}
        _ => buf.push(' '),
    }
    buf.push_str(next);
}

fn flush(out: &mut Vec<Block>, para: &mut Option<(String, &Line)>, page: u32) {
    if let Some((text, _)) = para.take() {
        out.push(Block::Para { text, page });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, size: f32, top: f32) -> Line {
        Line {
            text: text.into(),
            size,
            bold: false,
            top,
            bottom: top - size,
        }
    }

    #[test]
    fn merges_lines_and_detects_headings() {
        let pages = vec![PageLines {
            page: 1,
            needs_ocr: false,
            lines: vec![
                line("第一章 總則", 18.0, 800.0),
                line("請假申請需由組長", 10.0, 770.0),
                line("核准，超過三天另需", 10.0, 758.0),
                line("管理者同意。", 10.0, 746.0),
                line("1.1 適用範圍", 14.0, 720.0),
                line("This rule applies to every-", 10.0, 700.0),
                line("one in the team.", 10.0, 688.0),
                line("新的段落在比較遠的地方。", 10.0, 640.0),
            ],
        }];
        let b = lines_to_blocks(&pages);
        assert_eq!(
            b,
            vec![
                Block::Heading {
                    level: 1,
                    text: "第一章 總則".into(),
                    page: 1
                },
                Block::Para {
                    text: "請假申請需由組長核准，超過三天另需管理者同意。".into(),
                    page: 1
                },
                Block::Heading {
                    level: 2,
                    text: "1.1 適用範圍".into(),
                    page: 1
                },
                Block::Para {
                    text: "This rule applies to everyone in the team.".into(),
                    page: 1
                },
                Block::Para {
                    text: "新的段落在比較遠的地方。".into(),
                    page: 1
                },
            ]
        );
    }

    #[test]
    fn long_or_sentence_lines_are_not_headings() {
        let pages = vec![PageLines {
            page: 1,
            needs_ocr: false,
            lines: vec![
                line("大字但是一句完整的話。", 16.0, 800.0),
                line("本文", 10.0, 770.0),
                line("本文本文本文本文本文本文", 10.0, 758.0),
            ],
        }];
        let b = lines_to_blocks(&pages);
        assert!(b.iter().all(|x| !matches!(x, Block::Heading { .. })));
    }

    #[test]
    fn cjk_detection() {
        assert!(is_cjk('請'));
        assert!(is_cjk('，'));
        assert!(!is_cjk('a'));
    }
}
