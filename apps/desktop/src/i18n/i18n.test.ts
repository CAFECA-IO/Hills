import { describe, expect, it } from 'vitest';
import { en } from './en';
import { detectLocale, translate } from './index';
import { zhTW } from './zh-TW';

describe('i18n', () => {
  it('兩種語言的 key 完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
  });
  it('預設繁中，英文系統用英文', () => {
    expect(detectLocale(['zh-TW'])).toBe('zh-TW');
    expect(detectLocale(['ja-JP'])).toBe('zh-TW');
    expect(detectLocale(['en-US'])).toBe('en');
  });
  it('參數替換', () => {
    expect(translate('zh-TW', 'bench.running', { percent: 42 })).toBe('測試中… 42%');
  });
});
