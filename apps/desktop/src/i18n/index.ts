/**
 * 最小 i18n：繁體中文為預設、英文為第二語言（development-guidelines §4.2）。
 * 所有使用者可見文字都必須經由 t()。
 */
import { en } from './en';
import { zhTW, type MessageKey } from './zh-TW';

export type Locale = 'zh-TW' | 'en';
export const LOCALES: readonly Locale[] = ['zh-TW', 'en'];
const catalogs: Record<Locale, Record<MessageKey, string>> = { 'zh-TW': zhTW, en };
const STORAGE_KEY = 'hills.locale';

export function detectLocale(languages: readonly string[] = navigator.languages): Locale {
  const first = languages[0]?.toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'zh-TW';
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const template = catalogs[locale][key] ?? zhTW[key];
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-TW' || saved === 'en') return saved;
  } catch {
    // 無法存取 storage 時使用系統語言
  }
  return detectLocale();
}

const current = initialLocale();

export function getLocale(): Locale {
  return current;
}

/** 切換介面語言（重新載入畫面）。 */
export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 忽略：只影響下次啟動
  }
  window.location.reload();
}

export const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(current, key, params);

/** 依介面語言格式化時間。 */
export const formatTime = (ms: number) =>
  new Intl.DateTimeFormat(current, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

export type { MessageKey };

/** 時:分（今天以外加上日期）。 */
export const formatClock = (ms: number, now = Date.now()) => {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(current, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
};

/** 月/日。 */
export const formatDate = (ms: number) =>
  new Intl.DateTimeFormat(current, { month: 'numeric', day: 'numeric' }).format(ms);
