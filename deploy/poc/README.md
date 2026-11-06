# PoC：自架 iroh-relay

供「[M0][PoC] iroh 跨 NAT 連線驗證」使用。需要一台有公網 IP 與網域的主機。

```bash
cd deploy/poc
cp relay.toml.example relay.toml   # 填入網域與信箱
docker compose up -d --build
```

確認防火牆開放 TCP 80、443 與 UDP 7842。測試時兩端都加上 `--relay https://<你的網域>`：

```bash
cargo run --release -p net-echo -- --relay https://relay.example.com listen
cargo run --release -p net-echo -- --relay https://relay.example.com dial <ticket> --count 20
```

不加 `--relay` 時使用 iroh 官方公共 relay（只適合測試，正式環境一律自架，D1、D26）。
