//! 檔案分享的本機 I/O（technical-design §15.2–15.5、D39）。
//!
//! - 前端只能讀取本次以系統對話框選擇的檔案（以 token 代表，不暴露任意路徑）。
//! - 下載寫入使用者所選位置的 `<名稱>.partial`，全部驗證通過後才改名為正式檔名。
//! - 資料夾路徑一律經 [`safe_relative`] 處理（Windows 保留名稱、禁用字元、大小寫衝突、NFC）。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

/// 單次讀取上限（20 MiB 條帶）
pub const MAX_READ: u64 = 20 * 1024 * 1024;

const SYSTEM_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini", "Desktop.ini"];
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 本機對照用的隨機 token（前端只看得到 token，看不到路徑）。
fn token() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // 亂數不可用時退回時間；token 只在本機程序內對照
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        b = t.to_le_bytes();
    }
    data_encoding::HEXLOWER.encode(&b)
}

/// 單一路徑元件的安全化（不含 `/`）。
pub fn safe_component(name: &str) -> String {
    let nfc: String = name.nfc().collect();
    let mut s: String = nfc
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    // 結尾的空白或句點（Windows 會自動去除）
    if s.ends_with(' ') || s.ends_with('.') {
        s = format!("_{s}");
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        s = format!("_{s}");
    }
    if s.is_empty() || s == "." || s == ".." {
        s = "_".into();
    }
    s
}

/// 資料夾清單中的相對路徑：拒絕 `..`、絕對路徑、磁碟代號與 `\`；每段都安全化。
pub fn safe_relative(path: &str) -> Option<Vec<String>> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') {
        return None;
    }
    let mut out = Vec::new();
    for (i, seg) in path.split('/').enumerate() {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        // 磁碟代號（C:）
        if i == 0 && seg.len() == 2 && seg.ends_with(':') {
            return None;
        }
        out.push(safe_component(seg));
    }
    (!out.is_empty()).then_some(out)
}

/// 同一資料夾內不分大小寫的名稱衝突：後者加上 ` (2)`、` (3)`…
#[derive(Default)]
pub struct NameSpace {
    used: HashMap<PathBuf, HashSet<String>>,
    /// 已決定的對照：清單路徑 → 實際路徑元件
    assigned: HashMap<String, Vec<String>>,
}

fn with_suffix(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({n}){}", &name[..i], &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

impl NameSpace {
    /// 取得清單路徑對應的實際相對路徑（同一路徑重複呼叫結果相同）。
    pub fn resolve(&mut self, manifest_path: &str) -> Option<Vec<String>> {
        if let Some(p) = self.assigned.get(manifest_path) {
            return Some(p.clone());
        }
        let segs = safe_relative(manifest_path)?;
        let mut parent = PathBuf::new();
        let mut out = Vec::with_capacity(segs.len());
        // 目錄沿用父路徑已決定的名稱
        let parts: Vec<&str> = manifest_path.split('/').filter(|s| !s.is_empty()).collect();
        for (i, seg) in segs.iter().enumerate() {
            let key_prefix = parts[..=i.min(parts.len() - 1)].join("/");
            if i + 1 < segs.len()
                && let Some(prev) = self.assigned.get(&format!("{key_prefix}/"))
            {
                out.clone_from(prev);
                parent = out.iter().collect();
                continue;
            }
            let set = self.used.entry(parent.clone()).or_default();
            let mut name = seg.clone();
            let mut n = 2;
            while set.contains(&name.to_lowercase()) {
                name = with_suffix(seg, n);
                n += 1;
            }
            set.insert(name.to_lowercase());
            out.push(name);
            if i + 1 < segs.len() {
                self.assigned.insert(format!("{key_prefix}/"), out.clone());
            }
            parent = out.iter().collect();
        }
        self.assigned.insert(manifest_path.to_owned(), out.clone());
        Some(out)
    }
}

/// 讀取檔案的一段（最多 20 MiB）。
pub fn read_range(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    if len > MAX_READ {
        return Err("讀取長度過大".into());
    }
    let mut f = std::fs::File::open(path).map_err(|_| "無法開啟檔案".to_string())?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|_| "無法讀取檔案".to_string())?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len)
        .read_to_end(&mut buf)
        .map_err(|_| "無法讀取檔案".to_string())?;
    Ok(buf)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub token: String,
    pub name: String,
    pub size: u64,
    pub mtime: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FolderEntry {
    Dir {
        path: String,
    },
    File {
        path: String,
        token: String,
        size: u64,
        mtime: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    /// `symlink` / `system` / `unreadable`
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPick {
    pub root: String,
    pub entries: Vec<FolderEntry>,
    pub skipped: Vec<Skipped>,
    pub total_size: u64,
    pub file_count: usize,
}

/// 下載目標：單一檔案或資料夾根目錄。
#[derive(Debug, Clone)]
enum Target {
    File(PathBuf),
    Dir { root: PathBuf },
}

/// 本次執行期間使用者選擇的檔案與下載目標。
#[derive(Default)]
pub struct Registry {
    read: HashMap<String, PathBuf>,
    write: HashMap<String, (Target, NameSpace)>,
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// Windows 長路徑：寫入時使用 `\\?\` 前綴。
fn long_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.as_os_str().to_string_lossy();
        if !s.starts_with(r"\\?\") && p.is_absolute() {
            return PathBuf::from(format!(r"\\?\{s}"));
        }
    }
    p.to_path_buf()
}

impl Registry {
    pub fn add_file(&mut self, path: PathBuf) -> Option<PickedFile> {
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let name: String = path.file_name()?.to_string_lossy().nfc().collect();
        let t = token();
        self.read.insert(t.clone(), path);
        Some(PickedFile {
            token: t,
            name,
            size: meta.len(),
            mtime: mtime_ms(&meta),
        })
    }

    /// 列出資料夾（一次性快照，D36）：不跟隨符號連結，略過系統檔與無法讀取的檔案。
    pub fn add_folder(&mut self, root: &Path) -> std::io::Result<FolderPick> {
        let root_name: String = root
            .file_name()
            .map(|n| n.to_string_lossy().nfc().collect())
            .unwrap_or_else(|| "folder".into());
        let mut entries = Vec::new();
        let mut skipped = Vec::new();
        let mut total = 0u64;
        let mut stack = vec![(root.to_path_buf(), String::new())];
        while let Some((dir, rel)) = stack.pop() {
            let mut list: Vec<_> = match std::fs::read_dir(&dir) {
                Ok(r) => r.filter_map(Result::ok).collect(),
                Err(_) => {
                    skipped.push(Skipped {
                        path: rel.clone(),
                        reason: "unreadable",
                    });
                    continue;
                }
            };
            list.sort_by_key(|e| e.file_name());
            for e in list {
                let name: String = e.file_name().to_string_lossy().nfc().collect();
                let path = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{rel}/{name}")
                };
                let Ok(ft) = e.file_type() else {
                    skipped.push(Skipped {
                        path,
                        reason: "unreadable",
                    });
                    continue;
                };
                if ft.is_symlink() {
                    skipped.push(Skipped {
                        path,
                        reason: "symlink",
                    });
                } else if SYSTEM_FILES.contains(&name.as_str()) {
                    skipped.push(Skipped {
                        path,
                        reason: "system",
                    });
                } else if ft.is_dir() {
                    entries.push(FolderEntry::Dir { path: path.clone() });
                    stack.push((e.path(), path));
                } else if ft.is_file() {
                    match e
                        .metadata()
                        .and_then(|m| std::fs::File::open(e.path()).map(|_| m))
                    {
                        Ok(meta) => {
                            let t = token();
                            self.read.insert(t.clone(), e.path());
                            total += meta.len();
                            entries.push(FolderEntry::File {
                                path,
                                token: t,
                                size: meta.len(),
                                mtime: mtime_ms(&meta),
                            });
                        }
                        Err(_) => skipped.push(Skipped {
                            path,
                            reason: "unreadable",
                        }),
                    }
                }
            }
        }
        let file_count = entries
            .iter()
            .filter(|e| matches!(e, FolderEntry::File { .. }))
            .count();
        Ok(FolderPick {
            root: root_name,
            entries,
            skipped,
            total_size: total,
            file_count,
        })
    }

    /// 讀取已選擇檔案的一段明文。
    #[cfg(test)]
    pub fn read(&self, token: &str, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let path = self.read.get(token).ok_or("檔案未經選擇")?;
        read_range(path, offset, len)
    }

    /// 合併另一份登記（資料夾列舉在背景執行緒完成後）。
    pub fn merge(&mut self, other: Registry) {
        self.read.extend(other.read);
        self.write.extend(other.write);
    }

    /// 已選擇檔案的路徑（續傳工作保存用）。
    pub fn path_of(&self, token: &str) -> Option<PathBuf> {
        self.read.get(token).cloned()
    }

    /// 續傳：重新登記上次選擇的檔案，回傳新的 token（檔案已不存在時為 None）。
    pub fn restore(&mut self, path: PathBuf) -> Option<String> {
        std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
        let t = token();
        self.read.insert(t.clone(), path);
        Some(t)
    }

    pub fn add_target_file(&mut self, path: PathBuf) -> String {
        let t = token();
        self.write
            .insert(t.clone(), (Target::File(path), NameSpace::default()));
        t
    }

    pub fn add_target_dir(&mut self, root: PathBuf) -> String {
        let t = token();
        self.write
            .insert(t.clone(), (Target::Dir { root }, NameSpace::default()));
        t
    }

    /// 下載目標的正式路徑；資料夾下載時依清單路徑安全化並處理衝突。
    fn final_path(&mut self, token: &str, rel: &str) -> Result<PathBuf, String> {
        let (target, names) = self.write.get_mut(token).ok_or("下載目標無效")?;
        match target {
            Target::File(p) => Ok(p.clone()),
            Target::Dir { root } => {
                let segs = names.resolve(rel).ok_or("路徑不安全")?;
                let mut p = root.clone();
                for s in segs {
                    p.push(s);
                }
                // 結果必須仍在目標資料夾內
                if p.components().any(|c| matches!(c, Component::ParentDir)) {
                    return Err("路徑不安全".into());
                }
                Ok(p)
            }
        }
    }

    fn partial_of(path: &Path) -> PathBuf {
        let mut s = path.as_os_str().to_owned();
        s.push(".partial");
        PathBuf::from(s)
    }

    pub fn write_partial(
        &mut self,
        token: &str,
        rel: &str,
        offset: u64,
        data: &[u8],
    ) -> Result<(), String> {
        let final_path = self.final_path(token, rel)?;
        let partial = long_path(&Self::partial_of(&final_path));
        if let Some(dir) = partial.parent() {
            std::fs::create_dir_all(dir).map_err(|_| "無法建立資料夾".to_string())?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&partial)
            .map_err(|_| "無法寫入檔案".to_string())?;
        f.seek(SeekFrom::Start(offset))
            .and_then(|_| f.write_all(data))
            .map_err(|_| "無法寫入檔案".to_string())
    }

    /// 下載完成：`.partial` 改名為正式檔名（已存在同名檔案時加上 ` (2)`）。回傳實際檔名。
    pub fn finish(&mut self, token: &str, rel: &str, size: u64) -> Result<String, String> {
        let mut final_path = self.final_path(token, rel)?;
        let partial = long_path(&Self::partial_of(&final_path));
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(&partial)
            .map_err(|_| "找不到下載中的檔案".to_string())?;
        // 空檔案沒有寫入任何條帶
        f.set_len(size).map_err(|_| "無法寫入檔案".to_string())?;
        drop(f);
        let base = final_path.clone();
        let mut n = 2;
        while long_path(&final_path).exists() {
            let name = base
                .file_name()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_default();
            final_path = base.with_file_name(with_suffix(&name, n));
            n += 1;
        }
        std::fs::rename(&partial, long_path(&final_path))
            .map_err(|_| "無法完成下載".to_string())?;
        Ok(final_path
            .file_name()
            .map(|x| x.to_string_lossy().into_owned())
            .unwrap_or_default())
    }

    /// 下載失敗：刪除 `.partial`。
    pub fn abort(&mut self, token: &str, rel: &str) {
        if let Ok(p) = self.final_path(token, rel) {
            let _ = std::fs::remove_file(long_path(&Self::partial_of(&p)));
        }
    }

    /// 完成後在 Finder / 檔案總管中顯示的路徑。
    pub fn shown_path(&mut self, token: &str, rel: &str, name: &str) -> Option<PathBuf> {
        let p = self.final_path(token, rel).ok()?;
        Some(if name.is_empty() {
            p
        } else {
            p.with_file_name(name)
        })
    }

    /// 資料夾下載的根目錄。
    pub fn target_root(&self, token: &str) -> Option<PathBuf> {
        match &self.write.get(token)?.0 {
            Target::File(p) => Some(p.clone()),
            Target::Dir { root } => Some(root.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_are_made_safe() {
        assert_eq!(safe_component("CON"), "_CON");
        assert_eq!(safe_component("con.txt"), "_con.txt");
        assert_eq!(safe_component("LPT9.log"), "_LPT9.log");
        assert_eq!(safe_component("a<b>:c|d?*.txt"), "a_b__c_d__.txt");
        assert_eq!(safe_component("trail. "), "_trail. ");
        assert_eq!(safe_component("ok.txt"), "ok.txt");
        // macOS NFD → NFC
        let nfd = "e\u{301}.txt";
        assert_eq!(safe_component(nfd), "\u{e9}.txt");
    }

    #[test]
    fn relative_paths_reject_escapes() {
        assert!(safe_relative("../x").is_none());
        assert!(safe_relative("a/../../x").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("C:/x").is_none());
        assert!(safe_relative("a\\b").is_none());
        assert_eq!(
            safe_relative("設計稿/首頁/hero@2x.png").unwrap(),
            vec!["設計稿", "首頁", "hero@2x.png"]
        );
    }

    #[test]
    fn case_collisions_get_suffix() {
        let mut ns = NameSpace::default();
        assert_eq!(ns.resolve("a.txt").unwrap(), vec!["a.txt"]);
        assert_eq!(ns.resolve("A.txt").unwrap(), vec!["A (2).txt"]);
        assert_eq!(
            ns.resolve("a.txt").unwrap(),
            vec!["a.txt"],
            "同一路徑結果相同"
        );
        assert_eq!(ns.resolve("dir/x").unwrap(), vec!["dir", "x"]);
        assert_eq!(
            ns.resolve("dir/y").unwrap(),
            vec!["dir", "y"],
            "沿用同一目錄"
        );
        assert_eq!(ns.resolve("DIR/z").unwrap(), vec!["DIR (2)", "z"]);
    }

    #[test]
    fn folder_listing_skips_symlinks_and_system_files() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("設計稿");
        std::fs::create_dir_all(root.join("首頁")).unwrap();
        std::fs::write(root.join("首頁/hero.png"), b"12345").unwrap();
        std::fs::write(root.join(".DS_Store"), b"x").unwrap();
        std::fs::write(root.join("說明.txt"), b"hi").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("說明.txt"), root.join("link.txt")).unwrap();
        let mut reg = Registry::default();
        let pick = reg.add_folder(&root).unwrap();
        assert_eq!(pick.root, "設計稿");
        assert_eq!(pick.file_count, 2);
        assert_eq!(pick.total_size, 7);
        let reasons: Vec<_> = pick.skipped.iter().map(|s| s.reason).collect();
        assert!(reasons.contains(&"system"));
        #[cfg(unix)]
        assert!(reasons.contains(&"symlink"));
        let FolderEntry::File { token, .. } = pick
            .entries
            .iter()
            .find(|e| matches!(e, FolderEntry::File { path, .. } if path == "首頁/hero.png"))
            .unwrap()
        else {
            unreachable!()
        };
        assert_eq!(reg.read(token, 1, 3).unwrap(), b"234");
        assert!(reg.read("nope", 0, 1).is_err());
    }

    #[test]
    fn partial_then_rename() {
        let d = tempfile::tempdir().unwrap();
        let mut reg = Registry::default();
        let t = reg.add_target_dir(d.path().to_path_buf());
        reg.write_partial(&t, "資料夾/CON.txt", 3, b"def").unwrap();
        reg.write_partial(&t, "資料夾/CON.txt", 0, b"abc").unwrap();
        assert!(d.path().join("資料夾/_CON.txt.partial").exists());
        assert!(!d.path().join("資料夾/_CON.txt").exists());
        assert_eq!(reg.finish(&t, "資料夾/CON.txt", 6).unwrap(), "_CON.txt");
        assert_eq!(
            std::fs::read(d.path().join("資料夾/_CON.txt")).unwrap(),
            b"abcdef"
        );
        assert!(reg.write_partial(&t, "../escape", 0, b"x").is_err());
        // 單檔：已存在同名檔案時加上 (2)
        let f = reg.add_target_file(d.path().join("報告.pdf"));
        std::fs::write(d.path().join("報告.pdf"), b"old").unwrap();
        reg.write_partial(&f, "", 0, b"new").unwrap();
        assert_eq!(reg.finish(&f, "", 3).unwrap(), "報告 (2).pdf");
        let g = reg.add_target_file(d.path().join("壞.bin"));
        reg.write_partial(&g, "", 0, b"x").unwrap();
        reg.abort(&g, "");
        assert!(!d.path().join("壞.bin.partial").exists());
    }
}
