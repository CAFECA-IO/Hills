/** 可重現的 xorshift32 亂數，用於測試資料與相容性向量。 */
export function prng(seed: number): (n: number) => Uint8Array {
  let x = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      out[i] = x & 0xff;
    }
    return out;
  };
}

export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) return void out.push(acc.slice());
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}
