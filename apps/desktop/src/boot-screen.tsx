/**
 * 啟動畫面（ui-spec「啟動畫面」v0.26）：延遲 200 ms 才顯示；每次啟動隨機一個啟動動畫，不重複上次。
 */
import { useEffect, useState } from 'react';
import { BootArt, useCompassStage } from './boot-art';
import {
  isBootVariant,
  pickBoot,
  readLastBoot,
  writeLastBoot,
  type BootVariant,
} from './boot-utils';
import { t, type MessageKey } from './i18n';

const DELAY_MS = 200;

const STATUS: Record<BootVariant, MessageKey> = {
  a: 'boot.status.a',
  b: 'boot.status.b',
  c: 'boot.status.c2',
  d: 'boot.status.d',
  e: 'boot.status.e',
  f: 'boot.status.f',
};

/** 選這次的版本並記下；開發時可用 `?boot=a…f` 指定。 */
function chooseVariant(): BootVariant {
  if (import.meta.env.DEV) {
    const forced = new URLSearchParams(window.location.search).get('boot');
    if (isBootVariant(forced)) return forced;
  }
  const v = pickBoot(readLastBoot(), Math.random());
  writeLastBoot(v);
  return v;
}

export function BootScreen() {
  const [variant] = useState(chooseVariant);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  const stage = useCompassStage(shown && variant === 'c');
  if (!shown) return <div className="h-full bg-bg" />;
  const status =
    variant === 'c'
      ? t((['boot.status.c0', 'boot.status.c1', 'boot.status.c2'] as const)[stage])
      : t(STATUS[variant]);
  return (
    <main className="flex h-full flex-col items-center justify-center gap-5 bg-bg text-fg">
      <BootArt
        variant={variant}
        labels={[t('boot.d.product'), t('boot.d.eng'), t('boot.d.ops')]}
        caption={t('boot.e.caption')}
      />
      <div className="flex flex-col items-center gap-1.5">
        <h1 className="text-3xl font-bold">{t('app.name')}</h1>
        <p className="text-sm text-muted">{t('boot.tagline')}</p>
      </div>
      <p role="status" className="flex items-center text-xs text-muted">
        {status}
        {variant !== 'c' && (
          <span aria-hidden="true">
            <span className="boot-dot">.</span>
            <span className="boot-dot">.</span>
            <span className="boot-dot">.</span>
          </span>
        )}
      </p>
    </main>
  );
}
