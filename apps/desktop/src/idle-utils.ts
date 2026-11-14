/**
 * 計時的閒置 15 分鐘（ui-spec「計時與預估時數」v0.48；technical-design §16.18）：純函式。
 */
export const IDLE_LIMIT_S = 15 * 60;
/** 系統閒置少於這個秒數視為「回來了」。 */
export const BACK_S = 60;

export type IdleAction =
  { kind: 'pause'; at: number } | { kind: 'ask'; since: number; minutes: number } | null;

/**
 * 每次檢查的動作：計時中且閒置滿 15 分鐘 → 在開始閒置的那一刻停止；
 * 因閒置停止後使用者回來 → 詢問是否算進去。
 */
export function idleStep(
  s: { running: boolean; idleSince: number | null },
  idleSeconds: number | null,
  now: number,
): IdleAction {
  if (idleSeconds === null) return null;
  if (s.running && s.idleSince === null && idleSeconds >= IDLE_LIMIT_S)
    return { kind: 'pause', at: now - idleSeconds * 1000 };
  if (!s.running && s.idleSince !== null && idleSeconds < BACK_S)
    return { kind: 'ask', since: s.idleSince, minutes: Math.round((now - s.idleSince) / 60_000) };
  return null;
}
