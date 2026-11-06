#![allow(clippy::unwrap_used, clippy::expect_used)]
//! 檔案分片經 8 個儲存節點往返；任 3 個節點停止時仍可取得 5 片（technical-design §15.6–15.8、D39）。

mod common;
use common::*;
use hills_proto::ticket::StorageTicket;
use hills_storage::{STORAGE_ALPN, Storage};
use sha2::{Digest, Sha256};

struct StorageNode {
    router: Router,
    _dir: tempfile::TempDir,
}

async fn storage_node(index: u8, codes: &Path) -> StorageNode {
    let dir = tempfile::tempdir().unwrap();
    let s = Storage::open(dir.path(), None, hills_storage::DEFAULT_QUOTA).unwrap();
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![STORAGE_ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let code = StorageTicket::new(index, to_peer_addr(&ep.addr()))
        .to_code()
        .unwrap();
    std::fs::write(codes.join(format!("storage-{index}.txt")), code).unwrap();
    StorageNode {
        router: hills_storage::serve(ep, s),
        _dir: dir,
    }
}

#[tokio::test]
async fn shards_roundtrip_and_survive_three_nodes_down() {
    let mb = mailbox().await;
    let codes = tempfile::tempdir().unwrap();
    let mut nodes = Vec::new();
    for i in 0..8u8 {
        nodes.push(storage_node(i, codes.path()).await);
    }
    mb.mb.set_storage_codes_dir(codes.path().to_path_buf());

    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    // admin 同步：取得節點清單並推送 roster（第一次連線同時綁定組織）
    admin.sync_now().await.unwrap();
    admin.sync_now().await.unwrap();
    alice.sync_now().await.unwrap();
    assert_eq!(admin.storage_nodes(), (0..8).collect::<Vec<_>>());
    assert_eq!(alice.storage_nodes().len(), 8);

    // alice 上傳一個條帶的 8 個分片（內容即密文，節點只檢查 SHA-256）
    let shards: Vec<(u8, [u8; 32], Vec<u8>)> = (0..8u8)
        .map(|i| {
            let data: Vec<u8> = (0..65_536u32).map(|x| (x as u8) ^ i).collect();
            (i, Sha256::digest(&data).into(), data)
        })
        .collect();
    for (n, id, data) in &shards {
        alice.put_shard(*n, *id, data.clone()).await.unwrap();
    }
    assert_eq!(
        alice
            .has_shards(3, vec![shards[3].1, [0; 32]])
            .await
            .unwrap(),
        vec![true, false]
    );
    // admin 下載
    for (n, id, data) in &shards {
        assert_eq!(&admin.get_shard(*n, *id).await.unwrap(), data);
    }
    // 任 3 個節點停止：其餘 5 個仍可取得
    for i in [1usize, 4, 6] {
        nodes[i].router.shutdown().await.unwrap();
    }
    let mut ok = 0;
    for (n, id, data) in &shards {
        if let Ok(got) = admin.get_shard(*n, *id).await {
            assert_eq!(&got, data);
            ok += 1;
        }
    }
    assert_eq!(ok, 5);
    // 錯誤的 SHA-256 會被拒絕
    assert!(alice.put_shard(0, [1; 32], vec![1, 2, 3]).await.is_err());

    alice.shutdown().await;
    admin.shutdown().await;
    for n in nodes {
        let _ = n.router.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
