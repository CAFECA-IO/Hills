import type { MessageKey } from './zh-TW';

export const en: Record<MessageKey, string> = {
  'app.name': 'Hills',
  'app.tagline': 'See where your team is heading, from the top of the hill',
  'app.status.m0': 'In development (M0): app skeleton only.',
  'nav.devBench': 'Dev tool: file pipeline benchmark',
  'bench.title': 'SwarmStorage front-end pipeline benchmark',
  'bench.description':
    'Runs per-stripe AES-256-GCM encryption and Reed-Solomon (8,5) encoding on a simulated file in a Web Worker inside this WebView, then decodes it.',
  'bench.size': 'Size (MB)',
  'bench.run': 'Run',
  'bench.running': 'Running… {percent}%',
  'bench.result': 'Result',
  'bench.copy': 'Paste the JSON below into docs/poc-report.md.',
  'bench.error': 'Benchmark failed: {message}',
};
