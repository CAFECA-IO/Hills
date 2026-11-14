//! 下載的元件：PDF 引擎與向量模型（technical-design §16.20「元件與下載」）。
//!
//! URL、SHA-256 與大小固定寫在這裡（development-guidelines §2）；更換版本時三項一起更新並確認授權。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{DocAiError, Result};

/// 要下載的一個檔案。
#[derive(Debug, Clone, Copy)]
pub struct FileSpec {
    /// 存到元件資料夾的檔名
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

/// 一個可下載的元件。
#[derive(Debug, Clone, Copy)]
pub struct Component {
    pub id: &'static str,
    pub files: &'static [FileSpec],
    /// 下載後是否從 tgz 解出 pdfium 動態函式庫
    pub pdfium_archive: bool,
}

impl Component {
    pub fn size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// 向量模型的設定。
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub dim: usize,
    /// true = mean pooling（e5），false = CLS pooling（bge-m3）
    pub mean_pooling: bool,
    pub query_prefix: &'static str,
    pub passage_prefix: &'static str,
    pub max_tokens: usize,
    pub component: Component,
}

pub const E5_SMALL: ModelSpec = ModelSpec {
    id: "e5-small",
    dim: 384,
    mean_pooling: true,
    query_prefix: "query: ",
    passage_prefix: "passage: ",
    max_tokens: 512,
    component: Component {
        id: "e5-small",
        pdfium_archive: false,
        files: &[
            FileSpec {
                name: "model.onnx",
                url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx/model_quantized.onnx",
                sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
                size: 118_308_185,
            },
            FileSpec {
                name: "tokenizer.json",
                url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer.json",
                sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
                size: 17_082_730,
            },
            FileSpec {
                name: "config.json",
                url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/config.json",
                sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
                size: 658,
            },
            FileSpec {
                name: "special_tokens_map.json",
                url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/special_tokens_map.json",
                sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
                size: 167,
            },
            FileSpec {
                name: "tokenizer_config.json",
                url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer_config.json",
                sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
                size: 443,
            },
        ],
    },
};

pub const BGE_M3: ModelSpec = ModelSpec {
    id: "bge-m3",
    dim: 1024,
    mean_pooling: false,
    query_prefix: "",
    passage_prefix: "",
    max_tokens: 1024,
    component: Component {
        id: "bge-m3",
        pdfium_archive: false,
        files: &[
            FileSpec {
                name: "model.onnx",
                url: "https://huggingface.co/Xenova/bge-m3/resolve/4de13258303883538bd53b696b452bf8099f0858/onnx/model_quantized.onnx",
                sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
                size: 569_694_530,
            },
            FileSpec {
                name: "tokenizer.json",
                url: "https://huggingface.co/Xenova/bge-m3/resolve/4de13258303883538bd53b696b452bf8099f0858/tokenizer.json",
                sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
                size: 17_082_821,
            },
            FileSpec {
                name: "config.json",
                url: "https://huggingface.co/Xenova/bge-m3/resolve/4de13258303883538bd53b696b452bf8099f0858/config.json",
                sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95",
                size: 770,
            },
            FileSpec {
                name: "special_tokens_map.json",
                url: "https://huggingface.co/Xenova/bge-m3/resolve/4de13258303883538bd53b696b452bf8099f0858/special_tokens_map.json",
                sha256: "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835",
                size: 964,
            },
            FileSpec {
                name: "tokenizer_config.json",
                url: "https://huggingface.co/Xenova/bge-m3/resolve/4de13258303883538bd53b696b452bf8099f0858/tokenizer_config.json",
                sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4",
                size: 1173,
            },
        ],
    },
};

pub fn model_spec(id: &str) -> Option<&'static ModelSpec> {
    [&E5_SMALL, &BGE_M3].into_iter().find(|m| m.id == id)
}

pub const MODELS: [&ModelSpec; 2] = [&E5_SMALL, &BGE_M3];

macro_rules! pdfium_file {
    ($plat:literal, $sha:literal, $size:literal) => {
        FileSpec {
            name: "pdfium.tgz",
            url: concat!(
                "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/7543/pdfium-",
                $plat,
                ".tgz"
            ),
            sha256: $sha,
            size: $size,
        }
    };
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PDFIUM_FILE: Option<FileSpec> = Some(pdfium_file!(
    "mac-arm64",
    "41c269723b4711793de70ff34e65c00fa79907d6c023741837579e906b846faa",
    2_781_265
));
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const PDFIUM_FILE: Option<FileSpec> = Some(pdfium_file!(
    "mac-x64",
    "2510460ac106f14b884598a0da3f53a99e23d79512acf027c5e101c2bb2f26cb",
    2_899_900
));
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const PDFIUM_FILE: Option<FileSpec> = Some(pdfium_file!(
    "win-x64",
    "0b08b606792a6cc593426efdefc6622611bce446d9e0270743846956ea1554ca",
    3_075_408
));
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const PDFIUM_FILE: Option<FileSpec> = Some(pdfium_file!(
    "win-arm64",
    "bb4a00113494e25bbee52d3d63b7f4ecf0de2d277b7de75ba9a1d5b987a74509",
    2_917_957
));
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const PDFIUM_FILE: Option<FileSpec> = Some(pdfium_file!(
    "linux-x64",
    "9329a3c4b19b3c8d0a93af5440f44be84e4bd879a204e47b1a7a160e96809da4",
    2_957_508
));
#[cfg(not(any(
    all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(
        target_os = "windows",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(target_os = "linux", target_arch = "x86_64"),
)))]
const PDFIUM_FILE: Option<FileSpec> = None;

/// 這個平台的 PDF 引擎（不支援的平台回傳 `None`）。
pub fn pdfium_component() -> Option<Component> {
    static FILES: std::sync::OnceLock<Vec<FileSpec>> = std::sync::OnceLock::new();
    let f = PDFIUM_FILE?;
    let files = FILES.get_or_init(|| vec![f]);
    Some(Component {
        id: "pdfium",
        files: files.as_slice(),
        pdfium_archive: true,
    })
}

/// 元件資料夾：`<root>/<id>`。
pub fn component_dir(root: &Path, c: &Component) -> PathBuf {
    root.join(c.id)
}

/// pdfium 動態函式庫的位置。
pub fn pdfium_library(root: &Path) -> PathBuf {
    let dir = root.join("pdfium");
    pdfium_render::prelude::Pdfium::pdfium_platform_library_name_at_path(&dir)
}

const READY: &str = ".ready";

/// 元件是否已下載並驗證過。
pub fn is_ready(root: &Path, c: &Component) -> bool {
    let dir = component_dir(root, c);
    let stamp = std::fs::read_to_string(dir.join(READY)).unwrap_or_default();
    stamp == stamp_of(c)
}

fn stamp_of(c: &Component) -> String {
    c.files
        .iter()
        .map(|f| f.sha256)
        .collect::<Vec<_>>()
        .join(",")
}

fn http_client() -> Result<reqwest::Client> {
    // reqwest 以 rustls-no-provider 編譯：使用前需安裝 ring provider（已安裝時忽略）
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("hills/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| DocAiError::Download(e.to_string()))
}

/// 下載並驗證元件的所有檔案（支援續傳）。`progress(已下載, 總大小)`。
pub async fn download(
    root: &Path,
    c: &Component,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    if is_ready(root, c) {
        return Ok(());
    }
    let dir = component_dir(root, c);
    std::fs::create_dir_all(&dir)?;
    let client = http_client()?;
    let total = c.size();
    let mut base = 0;
    for f in c.files {
        let target = dir.join(f.name);
        if !(target.exists() && sha256_file(&target)? == f.sha256) {
            fetch(&client, f, &target, |n| progress(base + n, total)).await?;
        }
        base += f.size;
        progress(base, total);
    }
    if c.pdfium_archive {
        extract_pdfium(&dir.join("pdfium.tgz"), &dir)?;
    }
    std::fs::write(dir.join(READY), stamp_of(c))?;
    Ok(())
}

async fn fetch(
    client: &reqwest::Client,
    f: &FileSpec,
    target: &Path,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    use std::io::Write;
    let part = target.with_extension("part");
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > f.size {
        std::fs::remove_file(&part)?;
        have = 0;
    }
    let mut req = client.get(f.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| DocAiError::Download(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::OK {
        have = 0; // 伺服器不支援續傳：從頭開始
    } else if status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(DocAiError::Download(format!("HTTP {}", status.as_u16())));
    }
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(have > 0)
        .truncate(have == 0)
        .open(&part)?;
    let mut done = have;
    progress(done);
    while let Some(bytes) = resp
        .chunk()
        .await
        .map_err(|e| DocAiError::Download(e.to_string()))?
    {
        out.write_all(&bytes)?;
        done += bytes.len() as u64;
        if done > f.size {
            break;
        }
        progress(done);
    }
    out.flush()?;
    drop(out);
    if done != f.size || sha256_file(&part)? != f.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(DocAiError::Checksum);
    }
    std::fs::rename(&part, target)?;
    Ok(())
}

pub fn sha256_file(p: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(data_encoding::HEXLOWER.encode(&h.finalize()))
}

/// 從 pdfium-binaries 的 tgz 解出動態函式庫，放到元件資料夾根目錄。
fn extract_pdfium(archive: &Path, dir: &Path) -> Result<()> {
    let want = pdfium_render::prelude::Pdfium::pdfium_platform_library_name();
    let file = std::fs::File::open(archive)?;
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in ar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path.file_name() == Some(want.as_os_str()) {
            let dest = dir.join(&want);
            let mut out = std::fs::File::create(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
            return Ok(());
        }
    }
    Err(DocAiError::Engine("壓縮檔中沒有 pdfium 函式庫".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_well_formed() {
        for m in MODELS {
            assert!(m.dim > 0);
            for f in m.component.files {
                assert_eq!(f.sha256.len(), 64);
                assert!(f.url.starts_with("https://huggingface.co/"));
                assert!(f.size > 0);
            }
        }
        assert_eq!(model_spec("e5-small").map(|m| m.dim), Some(384));
        assert!(model_spec("nope").is_none());
    }

    #[test]
    fn readiness_follows_stamp() {
        let dir = tempfile::tempdir().unwrap();
        let c = &E5_SMALL.component;
        assert!(!is_ready(dir.path(), c));
        let d = component_dir(dir.path(), c);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(READY), stamp_of(c)).unwrap();
        assert!(is_ready(dir.path(), c));
    }
}
