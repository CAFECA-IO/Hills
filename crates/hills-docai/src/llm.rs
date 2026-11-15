//! 本機語言模型：llama.cpp 執行 Gemma 4 E4B（technical-design §16.21「元件」，D70）。
//!
//! 模型與 context 留在專用執行緒（llama.cpp 的物件不跨執行緒移動），其他執行緒以通道送工作。
//! 閒置 10 分鐘卸載模型，下次提問時再載入。

use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::sampling::LlamaSampler;

use crate::kbask::{Completion, Llm};
use crate::{DocAiError, Result};

/// context 長度（token）。
pub const N_CTX: u32 = 8192;
const N_BATCH: usize = 512;
const IDLE: Duration = Duration::from_secs(10 * 60);

enum Event {
    Token(String),
    Done(Result<String>),
}

struct Job {
    req: Completion,
    cancel: Arc<AtomicBool>,
    reply: Sender<Event>,
}

/// llama.cpp 的模型（一個行程一個）。
pub struct LlamaLlm {
    tx: Mutex<Sender<Job>>,
}

fn backend() -> Result<&'static LlamaBackend> {
    static B: OnceLock<std::result::Result<LlamaBackend, String>> = OnceLock::new();
    B.get_or_init(|| {
        LlamaBackend::init()
            .map(|mut b| {
                b.void_logs();
                b
            })
            .map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(|e| DocAiError::Llm(e.clone()))
}

fn llm_err(e: impl std::fmt::Display) -> DocAiError {
    DocAiError::Llm(e.to_string())
}

impl LlamaLlm {
    /// 啟動執行緒（模型在第一次使用時載入）。
    pub fn spawn(model_path: PathBuf) -> Result<Self> {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("hills-docai-llm".into())
            .spawn(move || worker(&model_path, &rx))?;
        Ok(Self { tx: Mutex::new(tx) })
    }
}

fn worker(path: &PathBuf, rx: &Receiver<Job>) {
    let mut model: Option<LlamaModel> = None;
    loop {
        let job = match rx.recv_timeout(IDLE) {
            Ok(j) => j,
            Err(RecvTimeoutError::Timeout) => {
                model = None;
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if model.is_none() {
            model = match load(path) {
                Ok(m) => Some(m),
                Err(e) => {
                    let _ = job.reply.send(Event::Done(Err(e)));
                    continue;
                }
            };
        }
        let Some(m) = model.as_ref() else { continue };
        let reply = job.reply.clone();
        let res = run(m, &job.req, &job.cancel, &mut |t| {
            let _ = reply.send(Event::Token(t.to_owned()));
        });
        let _ = job.reply.send(Event::Done(res));
    }
}

fn load(path: &PathBuf) -> Result<LlamaModel> {
    let b = backend()?;
    let params = LlamaModelParams::default();
    // macOS（Metal）把所有層放到 GPU；其他平台用 CPU
    #[cfg(target_os = "macos")]
    let params = params.with_n_gpu_layers(999);
    LlamaModel::load_from_file(b, path, &params).map_err(llm_err)
}

fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| i32::try_from(n.get().clamp(1, 8)).unwrap_or(4))
        .unwrap_or(4)
}

fn run(
    model: &LlamaModel,
    req: &Completion,
    cancel: &AtomicBool,
    on_token: &mut dyn FnMut(&str),
) -> Result<String> {
    let b = backend()?;
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(N_CTX))
        .with_n_batch(u32::try_from(N_BATCH).unwrap_or(512))
        .with_n_threads(threads())
        .with_n_threads_batch(threads());
    let mut ctx = model.new_context(b, ctx_params).map_err(llm_err)?;
    let vocab = model.vocab();
    let tokens = vocab.tokenize(req.prompt.as_bytes(), true, true);
    let limit = N_CTX as usize - req.max_tokens as usize;
    if tokens.is_empty() || tokens.len() > limit {
        return Err(DocAiError::Llm("問題與資料太長".into()));
    }
    let mut batch = LlamaBatch::new(N_BATCH, 1);
    let last = tokens.len() - 1;
    for (start, part) in tokens
        .chunks(N_BATCH)
        .enumerate()
        .map(|(i, p)| (i * N_BATCH, p))
    {
        if cancel.load(Ordering::Relaxed) {
            return Err(DocAiError::Cancelled);
        }
        batch.clear();
        for (j, t) in part.iter().enumerate() {
            let pos = start + j;
            batch
                .add(*t, i32::try_from(pos).map_err(llm_err)?, &[0], pos == last)
                .map_err(llm_err)?;
        }
        ctx.decode(&mut batch).map_err(llm_err)?;
    }
    let mut samplers = Vec::new();
    if let Some(g) = req.grammar {
        samplers.push(LlamaSampler::grammar(model, g, "root").map_err(llm_err)?);
    }
    if req.temperature <= 0.0 {
        samplers.push(LlamaSampler::greedy());
    } else {
        samplers.push(LlamaSampler::top_k(64));
        samplers.push(LlamaSampler::top_p(0.95, 1));
        samplers.push(LlamaSampler::temp(req.temperature));
        samplers.push(LlamaSampler::dist(0x4869_6c6c));
    }
    let mut sampler = LlamaSampler::chain_simple(samplers);
    let mut out = String::new();
    let mut pending: Vec<u8> = Vec::new();
    for pos in (tokens.len()..).take(req.max_tokens as usize) {
        if cancel.load(Ordering::Relaxed) {
            return Err(DocAiError::Cancelled);
        }
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        if vocab.is_eog(token) {
            break;
        }
        pending.extend(vocab.token_to_piece(token, false, None));
        // 只送出完整的 UTF-8
        let valid = match std::str::from_utf8(&pending) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid > 0 {
            let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out.push_str(&s);
            on_token(&s);
            if out.contains("<turn|>") {
                break;
            }
        }
        batch.clear();
        batch
            .add(token, i32::try_from(pos).map_err(llm_err)?, &[0], true)
            .map_err(llm_err)?;
        ctx.decode(&mut batch).map_err(llm_err)?;
    }
    Ok(out)
}

impl Llm for LlamaLlm {
    fn complete(
        &self,
        req: &Completion,
        on_token: &mut dyn FnMut(&str),
        cancel: &AtomicBool,
    ) -> Result<String> {
        let (reply, rx) = channel();
        let flag = Arc::new(AtomicBool::new(false));
        self.tx
            .lock()
            .map_err(|_| llm_err("lock"))?
            .send(Job {
                req: req.clone(),
                cancel: flag.clone(),
                reply,
            })
            .map_err(|_| llm_err("執行緒結束"))?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                flag.store(true, Ordering::Relaxed);
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Token(t)) => on_token(&t),
                Ok(Event::Done(r)) => return r,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err(llm_err("執行緒結束")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 需要已下載的模型：`HILLS_DOCAI_DIR=<元件資料夾> cargo test -p hills-docai -- --ignored`
    #[test]
    #[ignore]
    fn real_model_answers() {
        let dir = std::env::var("HILLS_DOCAI_DIR").expect("HILLS_DOCAI_DIR");
        let path = crate::models::llm_path(std::path::Path::new(&dir));
        let llm = LlamaLlm::spawn(path).unwrap();
        let cancel = AtomicBool::new(false);
        let intent = crate::kbask::understand(
            &llm,
            &crate::kbask::AskInput {
                question: "relay 斷線的時候訊息會不見嗎？".into(),
                history: Vec::new(),
            },
            &cancel,
        )
        .unwrap();
        assert!(!intent.queries.is_empty());
    }
}
