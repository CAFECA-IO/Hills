/**
 * 單元測試的共同設定：介面語言固定為英文，避免結果隨執行機器的系統語言改變
 * （Node 21 起 `navigator.languages` 取自系統，i18n 的 detectLocale 會讀它）。
 */
import { vi } from 'vitest';

vi.stubGlobal('navigator', { ...globalThis.navigator, language: 'en-US', languages: ['en-US'] });
