import { useRef, useState } from 'react';
import { t } from '../i18n';

type Msg =
  | { type: 'progress'; percent: number }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };

export default function SwarmBench() {
  const [sizeMb, setSizeMb] = useState(256);
  const [percent, setPercent] = useState<number | null>(null);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');
  const worker = useRef<Worker | null>(null);

  const run = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('./bench.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setPercent(0);
    setResult('');
    setError('');
    w.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.type === 'progress') setPercent(m.percent);
      if (m.type === 'done') {
        setPercent(null);
        setResult(JSON.stringify(m.result, null, 2));
        w.terminate();
      }
      if (m.type === 'error') {
        setPercent(null);
        setError(m.message);
        w.terminate();
      }
    };
    w.postMessage({ sizeMb });
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">{t('bench.title')}</h1>
      <p className="text-sm text-muted">{t('bench.description')}</p>
      <label className="flex items-center gap-2 text-sm">
        {t('bench.size')}
        <input
          className="w-28 rounded border border-line bg-surface px-2 py-1"
          type="number"
          min={20}
          step={20}
          value={sizeMb}
          onChange={(e) => setSizeMb(Number(e.target.value))}
        />
      </label>
      <button
        className="self-start rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
        disabled={percent !== null}
        onClick={run}
      >
        {percent === null ? t('bench.run') : t('bench.running', { percent })}
      </button>
      {error && <p className="text-sm">{t('bench.error', { message: error })}</p>}
      {result && (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">{t('bench.result')}</h2>
          <p className="text-sm text-muted">{t('bench.copy')}</p>
          <pre className="overflow-auto rounded border border-line bg-surface p-3 text-xs">
            {result}
          </pre>
        </section>
      )}
    </main>
  );
}
