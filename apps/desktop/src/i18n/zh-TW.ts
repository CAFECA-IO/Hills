export const zhTW = {
  'app.name': 'Hills',
  'app.tagline': '站在山丘上，俯瞰團隊前進方向',
  'app.status.m0': '開發中（M0）：目前只有應用程式骨架。',
  'nav.devBench': '開發工具：檔案管線效能測試',
  'bench.title': 'SwarmStorage 前端管線效能測試',
  'bench.description':
    '在此 WebView 的 Web Worker 中，對模擬檔案執行逐條帶 AES-256-GCM 加密與 Reed-Solomon (8,5) 編碼，再解碼還原。',
  'bench.size': '測試大小（MB）',
  'bench.run': '開始測試',
  'bench.running': '測試中… {percent}%',
  'bench.result': '結果',
  'bench.copy': '請將下方 JSON 貼到 docs/poc-report.md。',
  'bench.error': '測試失敗：{message}',
} as const;

export type MessageKey = keyof typeof zhTW;
