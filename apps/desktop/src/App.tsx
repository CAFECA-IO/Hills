import { lazy, Suspense, useEffect, useState } from 'react';
import { t } from './i18n';

// 開發用頁面只在 dev build 載入
const SwarmBench = import.meta.env.DEV ? lazy(() => import('./dev/SwarmBench')) : null;

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  if (SwarmBench && hash === '#/dev/swarm-bench') {
    return (
      <Suspense>
        <SwarmBench />
      </Suspense>
    );
  }
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-3xl font-semibold text-primary">{t('app.name')}</h1>
      <p className="text-muted">{t('app.tagline')}</p>
      <p className="rounded border border-line bg-surface px-3 py-2 text-sm">
        {t('app.status.m0')}
      </p>
      {SwarmBench && (
        <a className="text-sm text-primary underline" href="#/dev/swarm-bench">
          {t('nav.devBench')}
        </a>
      )}
    </main>
  );
}
