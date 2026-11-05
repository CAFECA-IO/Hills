/**
 * 以 SwarmStorage 原始實作產生 RS(8,5) 相容性向量。
 *
 *   git clone https://github.com/CAFECA-IO/swarmstorage /tmp/swarmstorage
 *   SWARMSTORAGE_DIR=/tmp/swarmstorage pnpm --filter @hills/swarm fixtures
 *
 * 產出 test/fixtures/rs-compat.json：對固定的 5 個資料分片，記錄原始實作算出的 3 個同位分片 SHA-256。
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prng } from '../helpers';

const dir = process.env.SWARMSTORAGE_DIR;
if (!dir) throw new Error('請設定 SWARMSTORAGE_DIR');
const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
const mod = await import(pathToFileURL(join(dir, 'src/lib/reed_solomon_erasure.ts')).href);
const rse = new mod.ReedSolomonErasure(5, 3);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const cases = [1, 7, 4096, 65537, 4 * 1024 * 1024 + 4].map((size, i) => {
  const seed = 0x48494c4c + i;
  const rnd = prng(seed);
  const shards = [
    ...Array.from({ length: 5 }, () => rnd(size)),
    ...Array.from({ length: 3 }, () => new Uint8Array(size)),
  ];
  rse.encode(shards);
  return { seed, size, data: shards.slice(0, 5).map(sha), parity: shards.slice(5).map(sha) };
});

writeFileSync(
  new URL('./rs-compat.json', import.meta.url),
  JSON.stringify({ source: 'CAFECA-IO/swarmstorage', commit, cases }, null, 2) + '\n',
);
console.log(`已產生 ${cases.length} 組向量（swarmstorage ${commit}）`);
