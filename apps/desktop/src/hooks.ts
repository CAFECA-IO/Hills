import { useEffect, useRef, useState } from 'react';
import { api, EVENTS, listen, type PresenceState, type SyncStatus } from './api';

/** 訂閱 node 事件（payload 為事件名稱，"all" 表示全部重新讀取）。 */
export function useNodeEvents(onEvent: (name: string) => void) {
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  });
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<string>(EVENTS.node, (name) => cb.current(name)).then((u) => {
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
}

/** 讀取資料，並在相關 node 事件發生時重新讀取。 */
export function useLoad<T>(load: () => Promise<T>, events: readonly string[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  useEffect(() => {
    let alive = true;
    loader
      .current()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [tick]);
  useNodeEvents((name) => {
    if (name === 'all' || events.includes(name)) setTick((x) => x + 1);
  });
  return { data, error, reload: () => setTick((x) => x + 1) };
}

export function useSyncStatus(): SyncStatus | null {
  const { data } = useLoad(api.syncStatus, ['status', 'activated']);
  return data;
}

const IDLE_MS = 10 * 60 * 1000;

/**
 * 本機閒置 10 分鐘自動「外出」，有活動時恢復原本狀態（technical-design §5.1）。
 * 只在自動切換時恢復；使用者手動設定的狀態不覆寫。
 */
export function useIdleAway(current: () => { state: PresenceState; note: string } | null) {
  const getter = useRef(current);
  useEffect(() => {
    getter.current = current;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let restore: { state: PresenceState; note: string } | null = null;
    const goIdle = () => {
      const cur = getter.current();
      if (cur && cur.state !== 'Away' && cur.state !== 'Leave') {
        restore = cur;
        void api.setPresence('Away', cur.note);
      }
    };
    const onActivity = () => {
      if (restore) {
        const r = restore;
        restore = null;
        void api.setPresence(r.state, r.note);
      }
      clearTimeout(timer);
      timer = setTimeout(goIdle, IDLE_MS);
    };
    const evs = ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    timer = setTimeout(goIdle, IDLE_MS);
    return () => {
      clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, []);
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return '';
}
