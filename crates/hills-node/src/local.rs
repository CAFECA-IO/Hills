//! 本地文件：Automerge 文件 + 每筆 change 的簽章（technical-design §16.5）。

use std::collections::HashMap;

use automerge::{AutoCommit, ChangeHash};
use hills_proto::{FORMAT_VERSION, Pub32, Sig64, Signed, SignedChange, SignedChangeBody};

pub struct LocalDoc {
    pub doc: AutoCommit,
    /// changeHash → (簽署裝置, 簽章)
    pub sigs: HashMap<[u8; 32], (Pub32, Sig64)>,
}

impl LocalDoc {
    pub fn new() -> Self {
        Self {
            doc: AutoCommit::new(),
            sigs: HashMap::new(),
        }
    }

    pub fn encode_sigs(&self) -> Vec<u8> {
        let v: Vec<(&[u8; 32], &Pub32, &Sig64)> =
            self.sigs.iter().map(|(h, (p, s))| (h, p, s)).collect();
        postcard::to_allocvec(&v).unwrap_or_default()
    }

    pub fn decode_sigs(bytes: &[u8]) -> HashMap<[u8; 32], (Pub32, Sig64)> {
        if bytes.is_empty() {
            return HashMap::new();
        }
        let v: Vec<([u8; 32], Pub32, Sig64)> = postcard::from_bytes(bytes).unwrap_or_default();
        v.into_iter().map(|(h, p, s)| (h, (p, s))).collect()
    }

    pub fn record(&mut self, sc: &SignedChange) {
        self.sigs.insert(sc.body.change_hash, (sc.signer, sc.sig));
    }

    /// 目前的 heads（排序後，便於比較）。
    pub fn heads(&mut self) -> Vec<[u8; 32]> {
        let mut h: Vec<[u8; 32]> = self.doc.get_heads().into_iter().map(|c| c.0).collect();
        h.sort();
        h
    }

    /// 對方的 heads 中有沒有我不知道的 change。
    pub fn missing_any(&mut self, heads: &[[u8; 32]]) -> bool {
        heads
            .iter()
            .any(|h| self.doc.get_change_by_hash(&ChangeHash(*h)).is_none())
    }

    /// 對方（持有 `have`）缺少的已簽章 change。`have` 中我不認識的 hash 會被忽略。
    pub fn signed_since(&mut self, doc_id: &str, have: &[[u8; 32]]) -> Vec<SignedChange> {
        let known: Vec<ChangeHash> = have
            .iter()
            .map(|h| ChangeHash(*h))
            .filter(|h| self.doc.get_change_by_hash(h).is_some())
            .collect();
        let changes = self.doc.get_changes(&known);
        changes
            .iter()
            .filter_map(|c| {
                let hash = c.hash().0;
                let (signer, sig) = self.sigs.get(&hash)?;
                Some(Signed {
                    body: SignedChangeBody {
                        v: FORMAT_VERSION,
                        doc_id: doc_id.to_owned(),
                        change_hash: hash,
                        author_device: *signer,
                        change: c.raw_bytes().to_vec(),
                    },
                    signer: *signer,
                    sig: *sig,
                })
            })
            .collect()
    }
}

impl Default for LocalDoc {
    fn default() -> Self {
        Self::new()
    }
}
