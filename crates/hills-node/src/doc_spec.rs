//! 文件規格 hills-doc/1（technical-design §16.16，D52）：段落解析與必填檢查。
//!
//! 前端也做同樣的檢查並負責 HTML 清理；這裡是寫入端的最後一道檢查，只看段落是否存在且有內文。

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

pub const SPEC_V1: &str = "hills-doc/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocFormat {
    #[default]
    Markdown,
    Html,
}

/// 文件種類決定必填段落。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Knowledge,
    /// `criteria`：任務有完成條件時，報告需「完成條件對照」
    Report {
        criteria: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Section {
    /// 段落 key；沒有 key 的自訂段落為 None
    pub key: Option<String>,
    pub title: String,
    /// 純文字內容（去除標記）
    pub text: String,
}

fn valid_key(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `標題 {#key}` → (標題, key)
fn split_heading(h: &str) -> (String, Option<String>) {
    let h = h.trim();
    if let Some(open) = h.rfind("{#")
        && h.ends_with('}')
    {
        let key = &h[open + 2..h.len() - 1];
        if valid_key(key) {
            return (h[..open].trim().to_owned(), Some(key.to_owned()));
        }
    }
    (h.to_owned(), None)
}

/// Markdown：每個 H2 開始一段（略過程式碼區塊內的 `##`）；第一個 H2 之前為前言（key = `lead`）。
pub fn markdown_sections(body: &str) -> Vec<Section> {
    let mut out = vec![Section {
        key: Some("lead".into()),
        title: String::new(),
        text: String::new(),
    }];
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(f) = fence {
            if t.starts_with(f) {
                fence = None;
            }
        } else if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(&t[..3]);
        } else if let Some(h) = t.strip_prefix("## ") {
            let (title, key) = split_heading(h);
            out.push(Section {
                key,
                title,
                text: String::new(),
            });
            continue;
        }
        if let Some(cur) = out.last_mut() {
            if !cur.text.is_empty() {
                cur.text.push('\n');
            }
            cur.text.push_str(line);
        }
    }
    for s in &mut out {
        s.text = s.text.trim().to_owned();
    }
    if out[0].text.is_empty() {
        out.remove(0);
    }
    out
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut skip_until: Option<&str> = None;
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if let Some(end) = skip_until {
            match lower[i..].find(end) {
                Some(p) => {
                    i += p + end.len();
                    skip_until = None;
                }
                None => break,
            }
            continue;
        }
        if !in_tag && lower[i..].starts_with("<style") {
            skip_until = Some("</style>");
            continue;
        }
        if !in_tag && lower[i..].starts_with("<script") {
            skip_until = Some("</script>");
            continue;
        }
        let Some(c) = html[i..].chars().next() else {
            break;
        };
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
        i += c.len_utf8();
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// HTML：`<section data-section="key">` 為段落，第一個 `<h2>` 為標題；只做簡單掃描（清理在前端）。
pub fn html_sections(body: &str) -> Vec<Section> {
    let lower = body.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(p) = lower[pos..].find("<section") {
        let start = pos + p;
        let Some(tag_end) = lower[start..].find('>').map(|e| start + e) else {
            break;
        };
        let tag = &body[start..tag_end];
        let key = attr(tag, "data-section");
        let end = lower[tag_end..]
            .find("</section>")
            .map_or(body.len(), |e| tag_end + e);
        let inner = &body[tag_end + 1..end.max(tag_end + 1)];
        let li = inner.to_ascii_lowercase();
        let (title, rest) = match (li.find("<h2"), li.find("</h2>")) {
            (Some(a), Some(b)) if a < b => (
                strip_tags(&inner[a..b]),
                format!("{}{}", &inner[..a], &inner[b + 5..]),
            ),
            _ => (String::new(), inner.to_owned()),
        };
        out.push(Section {
            key: key.filter(|k| valid_key(k)),
            title,
            text: strip_tags(&rest),
        });
        pos = end.min(body.len());
        if pos >= body.len() {
            break;
        }
    }
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let i = lower.find(&format!("{name}="))?;
    let rest = &tag[i + name.len() + 1..];
    let q = rest.chars().next()?;
    if q == '"' || q == '\'' {
        let end = rest[1..].find(q)?;
        Some(rest[1..=end].to_owned())
    } else {
        Some(
            rest.split(|c: char| c.is_whitespace() || c == '>')
                .next()?
                .to_owned(),
        )
    }
}

pub fn sections(format: DocFormat, body: &str) -> Vec<Section> {
    match format {
        DocFormat::Markdown => markdown_sections(body),
        DocFormat::Html => html_sections(body),
    }
}

pub fn required(kind: DocKind) -> &'static [&'static str] {
    match kind {
        DocKind::Knowledge => &["summary", "content"],
        DocKind::Report { criteria: true } => &["summary", "criteria"],
        DocKind::Report { criteria: false } => &["summary"],
    }
}

/// 缺少（或沒有內文）的必填段落。
pub fn missing(kind: DocKind, format: DocFormat, body: &str) -> Vec<&'static str> {
    let secs = sections(format, body);
    required(kind)
        .iter()
        .copied()
        .filter(|k| {
            !secs
                .iter()
                .any(|s| s.key.as_deref() == Some(*k) && !s.text.is_empty())
        })
        .collect()
}

/// 聲明規格時檢查必填段落；未知的規格拒絕。
pub fn check(spec: Option<&str>, kind: DocKind, format: DocFormat, body: &str) -> Result<()> {
    match spec {
        None => Ok(()),
        Some(SPEC_V1) => {
            let m = missing(kind, format, body);
            if m.is_empty() {
                Ok(())
            } else {
                bail!("缺少段落：{}", m.join("、"))
            }
        }
        Some(other) => bail!("不支援的文件規格：{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_sections_with_keys_and_custom() {
        let md = "前言一句\n\n## 摘要 {#summary}\n重點在這\n\n## 內容 {#content}\n```\n## 不是標題\n```\n內文\n\n## 我的段落\n自訂\n\n## 圖表 {#x-chart}\n圖";
        let s = markdown_sections(md);
        assert_eq!(s[0].key.as_deref(), Some("lead"));
        assert_eq!(s[1].key.as_deref(), Some("summary"));
        assert_eq!(s[1].title, "摘要");
        assert!(s[2].text.contains("## 不是標題"));
        assert_eq!(s[3].key, None);
        assert_eq!(s[4].key.as_deref(), Some("x-chart"));
        assert!(missing(DocKind::Knowledge, DocFormat::Markdown, md).is_empty());
    }

    #[test]
    fn markdown_missing_or_empty_required() {
        let md = "## 摘要 {#summary}\n\n## 內容 {#content}\n內文";
        assert_eq!(
            missing(DocKind::Knowledge, DocFormat::Markdown, md),
            vec!["summary"]
        );
        assert!(check(Some(SPEC_V1), DocKind::Knowledge, DocFormat::Markdown, md).is_err());
        assert!(check(None, DocKind::Knowledge, DocFormat::Markdown, md).is_ok());
        assert!(check(Some("x/2"), DocKind::Knowledge, DocFormat::Markdown, md).is_err());
    }

    #[test]
    fn html_sections_and_report_criteria() {
        let html = r#"<article data-hills-doc="1"><style>.a{color:red}</style>
<section data-section="summary"><h2>結果摘要</h2><p>共 31 項差異</p></section>
<section data-section='x-chart' class="a"><h2>圖</h2><table><tr><td>1</td></tr></table></section>
</article>"#;
        let s = html_sections(html);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].key.as_deref(), Some("summary"));
        assert_eq!(s[0].title, "結果摘要");
        assert_eq!(s[0].text, "共 31 項差異");
        assert_eq!(s[1].key.as_deref(), Some("x-chart"));
        assert!(missing(DocKind::Report { criteria: false }, DocFormat::Html, html).is_empty());
        assert_eq!(
            missing(DocKind::Report { criteria: true }, DocFormat::Html, html),
            vec!["criteria"]
        );
    }
}
