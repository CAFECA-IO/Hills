/**
 * 最小 i18n：繁體中文為預設、英文為第二語言（development-guidelines §4.2）。
 * 所有使用者可見文字都必須經由 t()。
 */
import { en } from './en';
import { zhTW, type MessageKey } from './zh-TW';

export type Locale = 'zh-TW' | 'en';
const catalogs: Record<Locale, Record<MessageKey, string>> = { 'zh-TW': zhTW, en };

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

const current = detectLocale();
export const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(current, key, params);
export type { MessageKey };
