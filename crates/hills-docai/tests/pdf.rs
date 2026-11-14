//! 需要已下載的 pdfium 與 e5-small：
//! `HILLS_DOCAI_DIR=<元件資料夾> cargo test -p hills-docai -- --ignored`

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

use hills_docai::{Block, Embedder, FastEmbedder, models, parse, pdf_to_chunks};
use pdfium_render::prelude::Pdfium;

fn root() -> PathBuf {
    PathBuf::from(std::env::var("HILLS_DOCAI_DIR").expect("HILLS_DOCAI_DIR"))
}

fn sample() -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.pdf")).unwrap()
}

fn pdfium() -> Pdfium {
    Pdfium::new(Pdfium::bind_to_library(models::pdfium_library(&root())).unwrap())
}

#[test]
#[ignore]
fn parses_headings_and_pages() {
    let p = pdfium();
    let pages = parse::read_pdf(&p, &sample()).unwrap();
    assert_eq!(pages.len(), 2);
    let blocks = parse::lines_to_blocks(&pages);
    for b in &blocks {
        println!("{b:?}");
    }
    assert!(
        blocks
            .iter()
            .any(|b| matches!(b, Block::Heading { level: 1, text, .. } if text == "山丘範例手冊"))
    );
    assert!(
        blocks.iter().any(
            |b| matches!(b, Block::Heading { text, page: 2, .. } if text.contains("公式與量測"))
        )
    );
    assert!(blocks.iter().any(|b| matches!(b, Block::Para { text, .. }
        if text.contains("請假申請需由組長核准，超過三天另需管理者同意。"))));
}

#[test]
#[ignore]
fn end_to_end_recall() {
    let p = pdfium();
    let chunks = pdf_to_chunks(&p, &sample()).unwrap();
    let mut e = FastEmbedder::load(&root(), &models::E5_SMALL).unwrap();
    let vecs = e
        .embed_passages(&chunks.iter().map(|c| c.embed_text()).collect::<Vec<_>>())
        .unwrap();
    let best = |q: &str, e: &mut FastEmbedder| {
        let qv = e.embed_query(q).unwrap();
        let (i, _) = vecs
            .iter()
            .enumerate()
            .map(|(i, v)| (i, v.iter().zip(&qv).map(|(a, b)| a * b).sum::<f32>()))
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .unwrap();
        chunks[i].clone()
    };
    assert!(best("事假要多早提出？", &mut e).text.contains("事假"));
    assert!(
        best("how often are certificates renewed", &mut e)
            .text
            .contains("Certificates")
    );
    let c = best("偏離怎麼計算", &mut e);
    assert_eq!(c.page_from, 2);
}

#[test]
#[ignore]
fn worker_parses_on_its_own_thread() {
    let w = hills_docai::PdfWorker::spawn(&root()).unwrap();
    let chunks = w.parse(sample()).unwrap();
    assert!(chunks.iter().any(|c| c.text.contains("特休")));
    assert!(matches!(
        w.parse(b"not a pdf".to_vec()),
        Err(hills_docai::DocAiError::BadPdf)
    ));
}

/// 需要網路：下載並驗證這個平台的 pdfium。
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn downloads_and_verifies_pdfium() {
    let dir = tempfile::tempdir().unwrap();
    let c = models::pdfium_component().unwrap();
    let mut last = 0;
    models::download(dir.path(), &c, |d, _| last = d)
        .await
        .unwrap();
    assert_eq!(last, c.size());
    assert!(models::is_ready(dir.path(), &c));
    assert!(models::pdfium_library(dir.path()).exists());
    hills_docai::load_pdfium(dir.path()).unwrap();
}
