//! 向量化（technical-design §16.20「向量化」）。

use std::path::Path;

use fastembed::{
    AutoDevicePolicy, InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};

use crate::models::{ModelSpec, component_dir};
use crate::{DocAiError, Result};

pub trait Embedder: Send {
    fn id(&self) -> &str;
    fn dim(&self) -> usize;
    /// 文件段落（已正規化）
    fn embed_passages(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    /// 查詢（已正規化）
    fn embed_query(&mut self, query: &str) -> Result<Vec<f32>>;
}

pub fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

/// fastembed + ONNX Runtime 的本機模型。
pub struct FastEmbedder {
    spec: &'static ModelSpec,
    model: TextEmbedding,
}

impl FastEmbedder {
    /// 從已下載的元件資料夾載入。
    pub fn load(root: &Path, spec: &'static ModelSpec) -> Result<Self> {
        let dir = component_dir(root, &spec.component);
        let read = |f: &str| std::fs::read(dir.join(f));
        let tokenizer = TokenizerFiles {
            tokenizer_file: read("tokenizer.json")?,
            config_file: read("config.json")?,
            special_tokens_map_file: read("special_tokens_map.json")?,
            tokenizer_config_file: read("tokenizer_config.json")?,
        };
        let model = UserDefinedEmbeddingModel::new(read("model.onnx")?, tokenizer).with_pooling(
            if spec.mean_pooling {
                Pooling::Mean
            } else {
                Pooling::Cls
            },
        );
        // 只用 CPU（technical-design §16.20 v0.42c）：ort 預設的自動選擇在 macOS 會啟用 CoreML，
        // 每種輸入長度都重新編譯模型，記憶體會暴增到數十 GB
        let opts = InitOptionsUserDefined::new()
            .with_max_length(spec.max_tokens)
            .with_auto_device(AutoDevicePolicy::PreferCPU);
        let model = TextEmbedding::try_new_from_user_defined(model, opts)
            .map_err(|e| DocAiError::Model(e.to_string()))?;
        Ok(Self { spec, model })
    }

    fn run(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let mut out = self
            .model
            .embed(texts, Some(8))
            .map_err(|e| DocAiError::Model(e.to_string()))?;
        out.iter_mut().for_each(|v| normalize(v));
        Ok(out)
    }
}

impl Embedder for FastEmbedder {
    fn id(&self) -> &str {
        self.spec.id
    }
    fn dim(&self) -> usize {
        self.spec.dim
    }
    fn embed_passages(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let p = self.spec.passage_prefix;
        self.run(texts.iter().map(|t| format!("{p}{t}")).collect())
    }
    fn embed_query(&mut self, query: &str) -> Result<Vec<f32>> {
        let q = format!("{}{query}", self.spec.query_prefix);
        self.run(vec![q])?
            .pop()
            .ok_or_else(|| DocAiError::Model("沒有輸出".into()))
    }
}

/// 測試用：字元 1-gram 與 2-gram 的雜湊向量（不需要模型）。
pub struct FakeEmbedder {
    pub dim: usize,
}

impl Default for FakeEmbedder {
    fn default() -> Self {
        Self { dim: 256 }
    }
}

impl FakeEmbedder {
    fn vec(&self, t: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; self.dim];
        let chars: Vec<char> = t
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect();
        let mut add = |s: &str, w: f32| {
            let h = blake3::hash(s.as_bytes());
            let b = h.as_bytes();
            let i = usize::from(u16::from_le_bytes([b[0], b[1]])) % self.dim;
            v[i] += w;
        };
        for c in &chars {
            add(&c.to_string(), 1.0);
        }
        for w in chars.windows(2) {
            add(&w.iter().collect::<String>(), 2.0);
        }
        normalize(&mut v);
        v
    }
}

impl Embedder for FakeEmbedder {
    fn id(&self) -> &str {
        "fake"
    }
    fn dim(&self) -> usize {
        self.dim
    }
    fn embed_passages(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| self.vec(t)).collect())
    }
    fn embed_query(&mut self, query: &str) -> Result<Vec<f32>> {
        Ok(self.vec(query))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_embedder_ranks_overlap_higher() {
        let mut e = FakeEmbedder::default();
        let p = e
            .embed_passages(&["請假要組長核准".into(), "伺服器部署步驟".into()])
            .unwrap();
        let q = e.embed_query("請假核准").unwrap();
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        assert!(dot(&q, &p[0]) > dot(&q, &p[1]));
        let n: f32 = q.iter().map(|x| x * x).sum();
        assert!((n - 1.0).abs() < 1e-4);
    }

    /// 需要已下載的模型：`HILLS_DOCAI_DIR=... cargo test -p hills-docai -- --ignored`
    #[test]
    #[ignore]
    fn e5_small_ranks_semantically() {
        let dir = std::env::var("HILLS_DOCAI_DIR").unwrap();
        let mut e = FastEmbedder::load(Path::new(&dir), &crate::models::E5_SMALL).unwrap();
        let p = e
            .embed_passages(&[
                "請假申請需由組長核准，超過三天另需管理者同意。".into(),
                "The relay server forwards encrypted packets.".into(),
            ])
            .unwrap();
        let q = e.embed_query("請假要找誰核准").unwrap();
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        assert_eq!(q.len(), 384);
        assert!(dot(&q, &p[0]) > dot(&q, &p[1]));
    }
}
