//! 知識條目 → 檢索用的段落（technical-design §16.20「知識條目」，D70）。純函式。
//!
//! Markdown 去掉標記、HTML 去掉標籤，`#` 與 `<h1>`–`<h3>` 轉成標題，再沿用 [`chunk_blocks`]。
//! 每段的標題路徑前面加上「分類 › 主題 › 知識標題」。

use crate::chunk::{Block, Chunk, Options, chunk_blocks};

/// 一則知識的文字。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbDoc {
    pub title: String,
    /// 分類、主題（由大到小）
    pub path: Vec<String>,
    pub body: String,
    pub html: bool,
}

/// 切成段落；內容是空的時候只有一段標題。
pub fn kb_chunks(doc: &KbDoc) -> Vec<Chunk> {
    let blocks = if doc.html {
        text_blocks(&html_to_text(&doc.body))
    } else {
        text_blocks(&markdown_to_text(&doc.body))
    };
    let mut prefix = doc.path.clone();
    prefix.push(doc.title.trim().to_owned());
    let mut chunks = chunk_blocks(&blocks, &Options::default());
    if chunks.is_empty() {
        chunks.push(Chunk {
            page_from: 0,
            page_to: 0,
            heading: Vec::new(),
            text: doc.title.trim().to_owned(),
        });
    }
    for c in &mut chunks {
        let mut h = prefix.clone();
        h.append(&mut c.heading);
        c.heading = h;
    }
    chunks
}

/// 知識的 HTML / Markdown 附件（technical-design §16.20 v0.42，D71）：依副檔名轉文字後切片。
/// 不是這兩種格式時回傳 `None`。
pub fn text_file_chunks(name: &str, bytes: &[u8]) -> Option<Vec<Chunk>> {
    let lower = name.to_lowercase();
    let text = String::from_utf8_lossy(bytes);
    let plain = if lower.ends_with(".html") || lower.ends_with(".htm") {
        html_to_text(&text)
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        markdown_to_text(&text)
    } else {
        return None;
    };
    Some(chunk_blocks(&text_blocks(&plain), &Options::default()))
}

/// 以 `#`／`##`／`###` 開頭的行為標題，空行分段。
fn text_blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut para = String::new();
    let flush = |para: &mut String, out: &mut Vec<Block>| {
        let t = para.trim();
        if !t.is_empty() {
            out.push(Block::Para {
                text: t.to_owned(),
                page: 0,
            });
        }
        para.clear();
    };
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            flush(&mut para, &mut out);
            continue;
        }
        let level = l.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && l[level..].starts_with(' ') {
            flush(&mut para, &mut out);
            let text = l[level..].trim().to_owned();
            if !text.is_empty() {
                out.push(Block::Heading {
                    level: u8::try_from(level.min(3)).unwrap_or(3),
                    text,
                    page: 0,
                });
            }
            continue;
        }
        if !para.is_empty() {
            para.push('\n');
        }
        para.push_str(l);
    }
    flush(&mut para, &mut out);
    out
}

/// Markdown → 純文字（保留 `#` 標題行，其他標記去掉）。
pub fn markdown_to_text(md: &str) -> String {
    let mut out = String::new();
    for raw in md.lines() {
        let mut line = raw.trim_end();
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            out.push('\n');
            continue;
        }
        // 表格分隔列
        if !t.is_empty() && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
            continue;
        }
        if t.starts_with('#') {
            let level = t.chars().take_while(|c| *c == '#').count();
            if t[level..].starts_with(' ') {
                // 去掉 `{#key}` 段落代碼（hills-doc/1）
                let head = strip_inline(t[level..].trim());
                let head = match head.rfind("{#") {
                    Some(i) if head.ends_with('}') => head[..i].trim_end().to_owned(),
                    _ => head,
                };
                out.push_str(&"#".repeat(level));
                out.push(' ');
                out.push_str(&head);
                out.push('\n');
                continue;
            }
        }
        line = t;
        // 引言與提示框
        while let Some(rest) = line.strip_prefix('>') {
            line = rest.trim_start();
        }
        if line.starts_with("[!") && line.ends_with(']') {
            continue;
        }
        // 清單符號
        for m in ["- [ ] ", "- [x] ", "* [ ] ", "* [x] ", "- ", "* ", "+ "] {
            if let Some(rest) = line.strip_prefix(m) {
                line = rest;
                break;
            }
        }
        let digits = line.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && line[digits..].starts_with(". ") {
            line = &line[digits + 2..];
        }
        let cleaned = strip_inline(&line.replace('|', " "));
        out.push_str(cleaned.trim());
        out.push('\n');
    }
    out
}

/// 去掉行內標記：粗體、斜體、程式碼、刪除線、連結與圖片（保留文字）。
fn strip_inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '!' if chars.get(i + 1) == Some(&'[') => {
                i += 1;
            }
            '[' => {
                // [文字](網址) → 文字
                if let Some(close) = chars[i + 1..].iter().position(|&x| x == ']') {
                    let end = i + 1 + close;
                    if chars.get(end + 1) == Some(&'(')
                        && let Some(p) = chars[end + 2..].iter().position(|&x| x == ')')
                    {
                        out.extend(&chars[i + 1..end]);
                        i = end + 2 + p + 1;
                        continue;
                    }
                }
                out.push(c);
                i += 1;
            }
            '*' | '`' | '~' => {
                i += 1;
            }
            '_' if chars.get(i + 1) == Some(&'_') => {
                i += 2;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// HTML → 純文字：`<h1>`–`<h6>` 變成 `#` 標題行，區塊結束換行，其他標籤去掉；`<script>`、`<style>` 內容略過。
pub fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    let mut skip_until: Option<&'static str> = None;
    while let Some(lt) = rest.find('<') {
        if skip_until.is_none() {
            out.push_str(&decode_entities(&rest[..lt]));
        }
        let after = &rest[lt + 1..];
        let Some(gt) = after.find('>') else {
            rest = "";
            break;
        };
        let tag = after[..gt].trim().to_ascii_lowercase();
        rest = &after[gt + 1..];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        if let Some(end) = skip_until {
            if closing && name == end {
                skip_until = None;
            }
            continue;
        }
        match name.as_str() {
            "script" if !closing => skip_until = Some("script"),
            "style" if !closing => skip_until = Some("style"),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                out.push('\n');
                if !closing {
                    let level = (name.as_bytes()[1] - b'0') as usize;
                    out.push_str(&"#".repeat(level));
                    out.push(' ');
                } else {
                    out.push('\n');
                }
            }
            "p" | "div" | "section" | "article" | "li" | "tr" | "pre" | "blockquote" | "ul"
            | "ol" | "table" => {
                out.push('\n');
                if closing {
                    out.push('\n');
                }
            }
            "br" => out.push('\n'),
            "td" | "th" => out.push(' '),
            _ => {}
        }
    }
    if skip_until.is_none() {
        out.push_str(&decode_entities(rest));
    }
    // 標題行內不能有換行；合併多餘空白
    out.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(body: &str, html: bool) -> KbDoc {
        KbDoc {
            title: "relay 部署".into(),
            path: vec!["部署".into(), "自架服務".into()],
            body: body.into(),
            html,
        }
    }

    #[test]
    fn markdown_headings_and_marks() {
        let md = "## 摘要 {#summary}\n\n**重點**：用 [docker](https://x) 啟動 `relay`。\n\n- 第一步\n- 第二步\n\n| a | b |\n|---|---|\n| 1 | 2 |";
        let t = markdown_to_text(md);
        assert!(t.contains("## 摘要\n"), "{t}");
        assert!(t.contains("重點：用 docker 啟動 relay。"), "{t}");
        assert!(t.contains("第一步\n第二步"), "{t}");
        assert!(!t.contains("---"));
    }

    #[test]
    fn chunks_carry_path_and_title() {
        let c = kb_chunks(&doc("## 步驟\n\n先開 UDP 7842。", false));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].heading, ["部署", "自架服務", "relay 部署", "步驟"]);
        assert_eq!(c[0].text, "先開 UDP 7842。");
    }

    #[test]
    fn attachment_text_files() {
        let c =
            text_file_chunks("規格.HTML", "<h2>流量</h2><p>每 5 分鐘一筆</p>".as_bytes()).unwrap();
        assert_eq!(c[0].heading, ["流量"]);
        assert_eq!(c[0].text, "每 5 分鐘一筆");
        assert!(text_file_chunks("a.md", b"# A\n\nb").is_some());
        assert!(text_file_chunks("a.pdf", b"%PDF").is_none());
    }

    #[test]
    fn empty_body_is_title_only() {
        let c = kb_chunks(&doc("", false));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].text, "relay 部署");
    }

    #[test]
    fn html_to_text_keeps_headings() {
        let h = "<section data-section=\"summary\"><h2>摘要</h2><p>先開 &amp; 檢查<br>UDP</p></section><script>alert(1)</script><p>完</p>";
        let t = html_to_text(h);
        assert!(t.contains("## 摘要"), "{t}");
        assert!(t.contains("先開 & 檢查\nUDP"), "{t}");
        assert!(!t.contains("alert"));
        let c = kb_chunks(&doc(h, true));
        assert_eq!(c[0].heading.last().map(String::as_str), Some("摘要"));
    }
}
