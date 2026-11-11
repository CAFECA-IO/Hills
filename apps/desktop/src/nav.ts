/**
 * 跨頁跳轉（ui-spec「檔案」v0.44，D64）：任何畫面都可以要求外框切到某個位置，
 * 例如「前往出處」與附件卡的「在檔案中顯示」。外框（shell.tsx）以 `useNavigation` 接收。
 */
import { useEffect, useRef } from 'react';

export type NavTarget =
  | { page: 'files'; conv?: string; fileKey?: string }
  | { page: 'chat'; conv: string; message?: string; fromFiles?: boolean }
  | { page: 'task'; team: string; task: string; fromFiles?: boolean }
  | { page: 'kb'; item: string; fromFiles?: boolean };

const EVENT = 'hills:navigate';

export function navigate(target: NavTarget) {
  window.dispatchEvent(new CustomEvent<NavTarget>(EVENT, { detail: target }));
}

export function useNavigation(handler: (target: NavTarget) => void) {
  const cb = useRef(handler);
  useEffect(() => {
    cb.current = handler;
  });
  useEffect(() => {
    const on = (e: Event) => cb.current((e as CustomEvent<NavTarget>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
