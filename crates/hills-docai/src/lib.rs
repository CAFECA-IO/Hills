//! 本機文件理解（D68，technical-design §16.20）。
//!
//! PDF → Markdown 區塊（[`parse`]）→ 切片（[`chunk`]）→ 向量（[`embed`]）→ 加密的本機索引與檢索（[`index`]）。
//! 引擎與模型在使用者開啟功能時下載（[`models`]）。內容只在本機處理，不同步、不上傳。

pub mod chunk;
pub mod embed;
pub mod hybrid;
pub mod index;
pub mod kbask;
pub mod kbtext;
#[cfg(feature = "llama")]
pub mod llm;
pub mod models;
pub mod parse;

pub use chunk::{Block, Chunk, chunk_blocks};
pub use embed::{Embedder, FakeEmbedder, FastEmbedder};
pub use hybrid::{Candidate, Found, SourceKind};
pub use index::{FileState, FileStatus, Hit, Index, KB_NAMES, Passage, Vault};
pub use kbask::{Answer, AskInput, Citation, FakeLlm, Hooks, Intent, IntentKind, Llm, Step, Turn};
pub use kbtext::{KbDoc, kb_chunks, text_file_chunks};
pub use models::{Component, ModelSpec, model_spec};

/// 單檔上限（technical-design §16.20）。
pub const MAX_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_PAGES: u16 = 500;

#[derive(Debug, thiserror::Error)]
pub enum DocAiError {
    #[error("無法讀取這個檔案")]
    BadPdf,
    #[error("檔案太大")]
    TooLarge,
    #[error("這份 PDF 沒有文字層")]
    NoText,
    #[error("PDF 引擎無法載入：{0}")]
    Engine(String),
    #[error("向量模型錯誤：{0}")]
    Model(String),
    #[error("下載失敗：{0}")]
    Download(String),
    #[error("檔案驗證失敗（雜湊不符）")]
    Checksum,
    #[error("索引讀寫失敗：{0}")]
    Store(String),
    #[error("已停止")]
    Cancelled,
    #[error("語言模型錯誤：{0}")]
    Llm(String),
    #[error("讀寫檔案失敗：{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, DocAiError>;

pub use pdfium_render::prelude::Pdfium;

/// 載入已下載的 pdfium（`root` = 元件根資料夾）。
pub fn load_pdfium(root: &std::path::Path) -> Result<Pdfium> {
    let lib = Pdfium::bind_to_library(models::pdfium_library(root))
        .map_err(|e| DocAiError::Engine(e.to_string()))?;
    Ok(Pdfium::new(lib))
}

/// pdfium 不能跨執行緒移動：在專用執行緒上載入並解析，其他執行緒透過通道送工作。
pub struct PdfWorker {
    tx: std::sync::mpsc::Sender<Job>,
}

type Job = (Vec<u8>, std::sync::mpsc::Sender<Result<Vec<Chunk>>>);

impl PdfWorker {
    /// 啟動執行緒並載入 pdfium；載入失敗時回傳錯誤。
    pub fn spawn(root: &std::path::Path) -> Result<Self> {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<()>>();
        let root = root.to_path_buf();
        std::thread::Builder::new()
            .name("hills-docai-pdf".into())
            .spawn(move || {
                let pdfium = match load_pdfium(&root) {
                    Ok(p) => {
                        let _ = ready_tx.send(Ok(()));
                        p
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                while let Ok((bytes, reply)) = rx.recv() {
                    let _ = reply.send(pdf_to_chunks(&pdfium, &bytes));
                }
            })?;
        ready_rx
            .recv()
            .map_err(|_| DocAiError::Engine("執行緒結束".into()))??;
        Ok(Self { tx })
    }

    pub fn parse(&self, bytes: Vec<u8>) -> Result<Vec<Chunk>> {
        let (reply, rx) = std::sync::mpsc::channel();
        self.tx
            .send((bytes, reply))
            .map_err(|_| DocAiError::Engine("執行緒結束".into()))?;
        rx.recv()
            .map_err(|_| DocAiError::Engine("執行緒結束".into()))?
    }
}

/// 解析並切片一份 PDF（不含向量化）。
pub fn pdf_to_chunks(pdfium: &Pdfium, bytes: &[u8]) -> Result<Vec<Chunk>> {
    if bytes.len() > MAX_BYTES {
        return Err(DocAiError::TooLarge);
    }
    let pages = parse::read_pdf(pdfium, bytes)?;
    let blocks = parse::lines_to_blocks(&pages);
    if blocks.is_empty() {
        return Err(DocAiError::NoText);
    }
    Ok(chunk_blocks(&blocks, &chunk::Options::default()))
}
