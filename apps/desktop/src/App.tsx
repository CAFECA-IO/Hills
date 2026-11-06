import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, errorMessage, type AppInfo } from './api';
import { useNodeEvents } from './hooks';
import { t } from './i18n';
import {
  BackupStep,
  CreateOrgForm,
  JoinForm,
  LinkNewDevice,
  Pending,
  PhraseFlow,
  RecoverForm,
  Welcome,
  type Start,
} from './onboarding';
import { Shell } from './shell';
import { Centered, ErrorText } from './ui';

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

/** 開發模式才顯示的工具入口（poc-report §5.2）。 */
function DevLink() {
  if (!SwarmBench) return null;
  return (
    <a
      className="fixed right-3 bottom-3 rounded-control border border-line bg-surface px-2 py-1 text-xs text-primary underline"
      href="#/dev/swarm-bench"
    >
      {t('nav.devBench')}
    </a>
  );
}

/** 建立 / 加入後依序經過的步驟（ui-spec「初次啟動與加入」）。 */
type Step = 'phrase' | 'backup' | null;

export function App() {
  return (
    <>
      <Main />
      <DevLink />
    </>
  );
}

function Main() {
  const hash = useHash();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState<Start | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);

  const refresh = useCallback(() => {
    api
      .appInfo()
      .then((i) => {
        setInfo(i);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(refresh, [refresh]);
  useNodeEvents((name) => {
    if (name === 'activated' || name === 'all' || name === 'roster') refresh();
  });

  if (SwarmBench && hash === '#/dev/swarm-bench') {
    return (
      <Suspense>
        <SwarmBench />
      </Suspense>
    );
  }
  if (error) {
    return (
      <Centered title={t('app.name')}>
        <ErrorText message={error} />
      </Centered>
    );
  }
  if (!info) {
    return (
      <Centered title={t('app.name')}>
        <p className="text-muted">{t('common.loading')}</p>
      </Centered>
    );
  }

  const step = steps[0];
  const nextStep = () => setSteps((s) => s.slice(1));
  if (step === 'phrase') return <PhraseFlow onDone={nextStep} />;
  if (step === 'backup') return <BackupStep onDone={nextStep} />;

  if (info.phase === 'welcome') {
    const back = () => setStart(null);
    const finished = (next: Step[]) => () => {
      setSteps(next);
      setStart(null);
      refresh();
    };
    switch (start) {
      case 'create':
        return <CreateOrgForm onBack={back} onDone={finished(['phrase', 'backup'])} />;
      case 'join':
        return <JoinForm onBack={back} onDone={finished(['phrase'])} />;
      case 'recover':
        return <RecoverForm onBack={back} onDone={finished([])} />;
      case 'link':
        return <LinkNewDevice onBack={back} onDone={finished([])} />;
      default:
        return <Welcome onPick={setStart} />;
    }
  }
  if (info.phase === 'pending') return <Pending />;
  return <Shell info={info} />;
}
