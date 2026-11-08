/**
 * 發佈本人的方向摘要（technical-design §16.14 v0.21，D47 第 2 批）：啟動後與任務 / 目標變更後
 * 30 秒內重算，內容和上次發佈的相同時不寫入。
 */
import { useEffect, useRef } from 'react';
import { api, type Task } from './api';
import { computeSummary, sameSummary } from './drift-utils';
import { useLoad } from './hooks';

const FIRST_DELAY = 3_000;
const DEBOUNCE = 30_000;

export function useDirectionPublisher(me: string | null, tasks: Task[] | null, timezone: string) {
  const plans = useLoad(() => api.plans(false), ['doc', 'org', 'roster']);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!me || !tasks || !plans.data) return;
    const items = plans.data;
    const first = last.current === null;
    const id = setTimeout(
      () => {
        void (async () => {
          const s = computeSummary(me, items, tasks, timezone, Date.now());
          const key = JSON.stringify(s);
          if (key === last.current) return;
          if (first) {
            const all = await api.directionSummaries().catch(() => []);
            const mine = all.find((m) => m.member === me)?.weeks[0];
            if (sameSummary(mine, s)) {
              last.current = key;
              return;
            }
          }
          try {
            await api.publishDirection({ ...s, updatedAt: 0 });
            last.current = key;
          } catch {
            // 下次變更時再試
          }
        })();
      },
      first ? FIRST_DELAY : DEBOUNCE,
    );
    return () => clearTimeout(id);
  }, [me, tasks, plans.data, timezone]);
}
