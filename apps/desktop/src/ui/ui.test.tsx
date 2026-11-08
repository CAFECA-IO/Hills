import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Button,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  ListButton,
  Menu,
  MenuItem,
  ProgressBar,
  SegmentedControl,
  Tabs,
  TextInput,
} from '.';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

describe('ui 元件（docs/components.md）', () => {
  it('Button 預設 type=button，busy 時停用並標示 aria-busy', () => {
    const h = html(<Button busy>存</Button>);
    expect(h).toContain('type="button"');
    expect(h).toContain('disabled=""');
    expect(h).toContain('aria-busy="true"');
    expect(html(<Button type="submit">存</Button>)).toContain('type="submit"');
  });

  it('IconButton 以 label 作為 aria-label 與 title', () => {
    const h = html(
      <IconButton label="關閉" onClick={noop}>
        ×
      </IconButton>,
    );
    expect(h).toContain('aria-label="關閉"');
    expect(h).toContain('title="關閉"');
  });

  it('ListButton selected 時設定 aria-current', () => {
    expect(html(<ListButton selected>a</ListButton>)).toContain('aria-current="true"');
    expect(html(<ListButton>a</ListButton>)).not.toContain('aria-current');
  });

  it('Field 把 id、說明與錯誤連到子控制項', () => {
    const h = html(
      <Field label="名稱" hint="說明" error="必填">
        <TextInput value="" onChange={noop} />
      </Field>,
    );
    const id = /<label for="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeTruthy();
    expect(h).toContain(`id="${id}"`);
    expect(h).toContain(`aria-describedby="${id}-hint ${id}-err"`);
    expect(h).toContain('aria-invalid="true"');
    expect(h).toContain('role="alert"');
  });

  it('Field 簡易寫法產生文字輸入', () => {
    const h = html(<Field label="名稱" value="x" onChange={noop} />);
    expect(h).toMatch(/<input[^>]*type="text"[^>]*value="x"/);
  });

  it('Checkbox 有 label 時以 label 包住', () => {
    const h = html(<Checkbox label="同意" checked={false} onChange={noop} />);
    expect(h).toMatch(/^<label[^>]*><input[^>]*type="checkbox"/);
    expect(h).toContain('同意');
  });

  it('Dialog 是 aria-modal 的對話框，onSubmit 時為 form', () => {
    const h = html(
      <Dialog title="新目標" onClose={noop}>
        內容
      </Dialog>,
    );
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
    expect(h).toContain('aria-label="新目標"');
    expect(h).toContain('<h2');
    expect(
      html(
        <Dialog label="x" onClose={noop} onSubmit={noop}>
          內容
        </Dialog>,
      ),
    ).toMatch(/<form[^>]*role="dialog"/);
  });

  it('SegmentedControl 與 Tabs：tablist、aria-selected、只有選取的可 Tab 聚焦', () => {
    const opts = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ];
    for (const C of [SegmentedControl, Tabs]) {
      const h = html(<C label="檢視" options={opts} value="b" onChange={noop} />);
      expect(h).toContain('role="tablist"');
      expect(h).toContain('aria-label="檢視"');
      expect(h.match(/aria-selected="true"/g)).toHaveLength(1);
      expect(h).toMatch(/aria-selected="false" tabindex="-1"/);
      expect(h).toMatch(/aria-selected="true" tabindex="0"/);
    }
  });

  it('Menu 與 MenuItem 的角色', () => {
    const h = html(
      <Menu label="附加" onClose={noop}>
        <MenuItem onSelect={noop}>檔案</MenuItem>
      </Menu>,
    );
    expect(h).toContain('role="menu"');
    expect(h).toContain('role="none"');
    expect(h).toContain('role="menuitem"');
  });

  it('Chip 只有傳 selected 時才是切換型', () => {
    expect(html(<Chip selected>x</Chip>)).toContain('aria-pressed="true"');
    expect(html(<Chip>x</Chip>)).not.toContain('aria-pressed');
  });

  it('ProgressBar 夾在 0–100 並提供無障礙名稱', () => {
    const h = html(<ProgressBar value={1.4} label="上傳" />);
    expect(h).toContain('aria-valuenow="100"');
    expect(h).toContain('aria-label="上傳"');
    expect(html(<ProgressBar value={-1} label="x" />)).toContain('aria-valuenow="0"');
  });

  it('Badge 與 EmptyState', () => {
    expect(html(<Badge label="3 則未讀">3</Badge>)).toContain('aria-label="3 則未讀"');
    expect(html(<EmptyState action={<Button>新增</Button>}>沒有資料</EmptyState>)).toContain(
      '沒有資料',
    );
  });
});
