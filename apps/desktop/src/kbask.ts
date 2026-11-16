/**
 * 問知識庫的前端狀態（ui-spec「知識庫 › 問知識庫」v0.51、technical-design §16.21，D70）。
 * 對話只在記憶體：重開 app 或按「新的問題」就清空。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  api,
  EVENTS,
  listen,
  type AskAnswer,
  type AskIntent,
  type AskTurn,
  type KbAskStatus,
} from './api';

export type AskPhase =
  'understanding' | 'searching' | 'answering' | 'done' | 'notFound' | 'error' | 'cancelled';

export interface AskScope {
  /** 分類 id 或知識 key */
  id: string;
  label: string;
}

export interface AskMessage {
  askId: number | null;
  question: string;
  scope: AskScope | null;
  phase: AskPhase;
  intent: AskIntent | null;
  found: { items: number; pdfs: number } | null;
  /** 串流中的文字（完成後以 `answer.answer` 為準） */
  text: string;
  answer: AskAnswer | null;
  error: string | null;
  /** 理解問題之前的準備：更新知識索引或載入語言模型 */
  prep: { kind: 'indexing'; items: number } | { kind: 'loading' } | null;
  /** 送出時間（顯示已經過幾秒） */
  startedAt: number;
  /** 回答後的追問建議（v0.53） */
  followUps: string[];
  /** 以修改過的查詢重問（v0.53） */
  edited: boolean;
}

// ── 狀態（設定與知識庫共用） ─────────────────────────────

let status: KbAskStatus | null = null;
const subs = new Set<() => void>();
let listening = false;

export async function refreshKbAsk(): Promise<void> {
  try {
    status = await api.kbaskStatus();
  } catch {
    status = null;
  }
  subs.forEach((cb) => cb());
}

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!listening) {
    listening = true;
    void listen<string>(EVENTS.docai, () => void refreshKbAsk());
    void refreshKbAsk();
  }
  return () => {
    subs.delete(cb);
  };
}

export function useKbAskStatus(): KbAskStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}

// ── 對話 ─────────────────────────────────────────

/** 送給後端的前幾輪（只取完成的，最近 3 輪）。 */
export function historyOf(msgs: AskMessage[]): AskTurn[] {
  return msgs
    .filter((m) => m.phase === 'done' && m.answer && m.answer.answer)
    .slice(-3)
    .map((m) => ({ question: m.question, answer: m.answer?.answer ?? '' }));
}

/** 套用一個事件；askId 不符時不變。 */
export function applyEvent(
  m: AskMessage,
  ev:
    | { type: 'step'; step: 'indexing'; items: number }
    | { type: 'step'; step: 'loading' }
    | { type: 'step'; step: 'understood'; intent: AskIntent }
    | { type: 'step'; step: 'found'; items: number; pdfs: number }
    | { type: 'step'; step: 'answering' }
    | { type: 'token'; text: string }
    | { type: 'done'; answer: AskAnswer }
    | { type: 'error'; message: string; cancelled: boolean },
): AskMessage {
  switch (ev.type) {
    case 'step':
      if (ev.step === 'indexing') return { ...m, prep: { kind: 'indexing', items: ev.items } };
      if (ev.step === 'loading') return { ...m, prep: { kind: 'loading' } };
      if (ev.step === 'understood')
        return { ...m, intent: ev.intent, phase: 'searching', prep: null };
      if (ev.step === 'found')
        return { ...m, found: { items: ev.items, pdfs: ev.pdfs }, phase: 'searching' };
      return { ...m, phase: 'answering' };
    case 'token':
      return { ...m, text: m.text + ev.text, phase: 'answering' };
    case 'done':
      return {
        ...m,
        answer: ev.answer,
        intent: ev.answer.understood,
        text: ev.answer.answer,
        phase: ev.answer.notFound ? 'notFound' : 'done',
      };
    case 'error':
      return { ...m, phase: ev.cancelled ? 'cancelled' : 'error', error: ev.message };
  }
}

const newMessage = (question: string, scope: AskScope | null): AskMessage => ({
  askId: null,
  question,
  scope,
  phase: 'understanding',
  intent: null,
  found: null,
  text: '',
  answer: null,
  error: null,
  prep: null,
  startedAt: Date.now(),
  followUps: [],
  edited: false,
});

/** 一段問答對話。 */
export function useKbAsk() {
  const [msgs, setMsgs] = useState<AskMessage[]>([]);
  const current = useRef<number | null>(null);
  const latest = useRef<AskMessage[]>([]);
  useEffect(() => {
    latest.current = msgs;
  });

  /** 回答完成後產生追問建議（背景；提問時後端會中斷） */
  const followUp = useCallback(async (askId: number, answer: AskAnswer | undefined) => {
    if (!answer || answer.notFound || answer.citations.length === 0) return;
    const m = latest.current.find((x) => x.askId === askId);
    if (!m) return;
    try {
      const q = await api.kbaskFollowUps(m.question, answer.answer, [
        ...new Set(answer.citations.map((c) => c.title)),
      ]);
      if (q.length > 0)
        setMsgs((all) => all.map((x) => (x.askId === askId ? { ...x, followUps: q } : x)));
    } catch {
      // 追問建議是附加的，失敗就不顯示
    }
  }, []);

  useEffect(() => {
    const offs: Promise<() => void>[] = [];
    type Raw = { askId: number } & Record<string, unknown>;
    const on = (event: string, type: 'step' | 'token' | 'done' | 'error') =>
      offs.push(
        listen<Raw>(event, (p) => {
          setMsgs((all) =>
            all.map((m) =>
              m.askId === p.askId
                ? applyEvent(m, { ...p, type } as unknown as Parameters<typeof applyEvent>[1])
                : m,
            ),
          );
          if ((type === 'done' || type === 'error') && current.current === p.askId)
            current.current = null;
          if (type === 'done') void followUp(p.askId, p.answer as AskAnswer | undefined);
        }),
      );
    on(EVENTS.askStep, 'step');
    on(EVENTS.askToken, 'token');
    on(EVENTS.askDone, 'done');
    on(EVENTS.askError, 'error');
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, [followUp]);

  const send = useCallback(
    async (question: string, scope: AskScope | null, queries: string[] | null = null) => {
      const q = question.trim();
      if (!q) return;
      const history = historyOf(msgs);
      const idx = msgs.length;
      setMsgs((all) => [...all, { ...newMessage(q, scope), edited: !!queries }]);
      try {
        const askId = await api.kbaskAsk(q, history, scope?.id ?? null, queries);
        current.current = askId;
        setMsgs((all) => all.map((m, i) => (i === idx ? { ...m, askId } : m)));
      } catch (err) {
        setMsgs((all) =>
          all.map((m, i) => (i === idx ? { ...m, phase: 'error', error: String(err) } : m)),
        );
      }
    },
    [msgs],
  );

  const stop = useCallback(() => {
    if (current.current !== null) void api.kbaskCancel(current.current);
  }, []);

  const reset = useCallback(() => {
    stop();
    setMsgs([]);
  }, [stop]);

  const last = msgs[msgs.length - 1];
  const busy =
    !!last &&
    (last.phase === 'understanding' || last.phase === 'searching' || last.phase === 'answering');
  return { msgs, send, stop, reset, busy };
}
