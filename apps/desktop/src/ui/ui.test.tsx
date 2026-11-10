import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import {
  Badge,
  Button,
  CharacterStage,
  GlassNav,
  GlassPanel,
  GlassScope,
  Card,
  ScopeTag,
  SwatchGroup,
  Checkbox,
  ChoiceCard,
  ConfirmDialog,
  Chip,
  Dialog,
  DialogFooter,
  EmptyState,
  Field,
  IconButton,
  ListButton,
  Markdown,
  applyEdit,
  Menu,
  MenuItem,
  NoticeDialog,
  Skeleton,
  ProgressBar,
  Select,
  SegmentedControl,
  Stepper,
  Switch,
  Tabs,
  TextInput,
  Toast,
  Tooltip,
} from '.';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

describe('ui 元件（docs/components.md）', () => {
  it('GlassPanel 標題與範圍標籤；GlassScope 內的 Card 改用毛玻璃底層', () => {
    const h = html(
      <GlassPanel title="通知" scope={{ scope: 'me', label: '只有我' }}>
        x
      </GlassPanel>,
    );
    expect(h).toContain('<h2');
    expect(h).toContain('只有我');
    expect(h).toContain('aria-hidden="true"');
    expect(html(<Card>a</Card>)).toContain('bg-surface');
    expect(
      html(
        <GlassScope>
          <Card>a</Card>
        </GlassScope>,
      ),
    ).not.toContain('bg-surface');
    expect(html(<ScopeTag scope="device" label="這台電腦" />)).toContain('這台電腦');
  });

  it('SwatchGroup 是 radiogroup，只有選取的色票可 tab 到', () => {
    const h = html(
      <SwatchGroup
        label="頭髮"
        colors={['red', 'blue']}
        value={1}
        onChange={noop}
        optionLabel={(i) => `頭髮 第 ${i + 1} 色`}
      />,
    );
    expect(h).toContain('role="radiogroup"');
    expect(h).toContain('aria-label="頭髮"');
    expect(h).toContain('aria-checked="true"');
    expect(h.match(/tabindex="0"/g)).toHaveLength(1);
    expect(h).toContain('aria-label="頭髮 第 2 色"');
  });

  it('CharacterStage 有前後箭頭、aria-live 與圓點', () => {
    const h = html(
      <CharacterStage
        count={7}
        index={2}
        onChange={noop}
        label="我的角色：貓"
        prevLabel="上一個角色"
        nextLabel="下一個角色"
      >
        <svg />
      </CharacterStage>,
    );
    expect(h).toContain('aria-label="上一個角色"');
    expect(h).toContain('aria-label="下一個角色"');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain('aria-label="我的角色：貓"');
    expect(h.match(/rounded-full transition-all/g)).toHaveLength(7);
  });

  it('GlassNav 標示目前分組、數字徽章與提醒圓點', () => {
    const h = html(
      <GlassNav
        label="設定分組"
        value="b"
        onChange={noop}
        items={[
          { value: 'a', label: 'A', dotLabel: '有待處理' },
          { value: 'b', label: 'B', count: 2, countLabel: '2 筆待核准' },
        ]}
      />,
    );
    expect(h).toContain('aria-label="設定分組"');
    expect(h).toContain('aria-current="page"');
    expect(h).toContain('aria-label="有待處理"');
    expect(h).toContain('aria-label="2 筆待核准"');
  });

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

  it('ChoiceCard 是 radiogroup，只有選取的卡可 Tab 聚焦；未選時第一張', () => {
    const opts = [
      { value: 'a', title: 'A', description: '說明' },
      { value: 'b', title: 'B', dashed: true },
    ];
    const h = html(<ChoiceCard label="方向" options={opts} value="b" onChange={noop} />);
    expect(h).toContain('role="radiogroup"');
    expect(h).toContain('aria-label="方向"');
    expect(h).toMatch(/role="radio" aria-checked="false" tabindex="-1"/);
    expect(h).toMatch(/role="radio" aria-checked="true" tabindex="0"/);
    const none = html(<ChoiceCard label="方向" options={opts} value={null} onChange={noop} />);
    expect(none).toMatch(/aria-checked="false" tabindex="0"[^]*aria-checked="false" tabindex="-1"/);
  });

  it('Switch 是 role=switch，以 aria-checked 表示開關，label 以 aria-labelledby 連結', () => {
    const on = html(<Switch checked label="進階檢視" description="說明" onChange={noop} />);
    expect(on).toMatch(/<button type="button" role="switch" id="([^"]+)" aria-checked="true"/);
    const id = /role="switch" id="([^"]+)"/.exec(on)?.[1];
    expect(on).toContain(`aria-labelledby="${id}-label"`);
    expect(on).toContain(`aria-describedby="${id}-desc"`);
    expect(on).toContain(`<label id="${id}-label" for="${id}"`);
    const off = html(<Switch checked={false} aria-label="合併" onChange={noop} />);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('aria-label="合併"');
  });

  it('Stepper 標示目前步驟', () => {
    const h = html(<Stepper label="規劃步驟" steps={['一', '二', '三']} current={1} />);
    expect(h).toContain('aria-label="規劃步驟"');
    expect(h).toMatch(/aria-current="step"[^>]*>二/);
    expect(h.match(/aria-current/g)).toHaveLength(1);
    expect(h).toContain('✓');
  });

  it('Tooltip 以 aria-describedby 連到 role=tooltip 的卡片', () => {
    const h = html(
      <Tooltip content="摘要">
        <Button>小華</Button>
      </Tooltip>,
    );
    const id = /aria-describedby="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeTruthy();
    expect(h).toMatch(new RegExp(`id="${id}" role="tooltip" class="[^"]*hidden`));
    expect(
      html(
        <Tooltip content="摘要" open>
          <Button>小華</Button>
        </Tooltip>,
      ),
    ).not.toMatch(/role="tooltip" class="[^"]*hidden/);
  });

  it('Toast 是 role=status，附復原按鈕', () => {
    const h = html(
      <Toast message="已加入" action={{ label: '復原', onClick: noop }} onClose={noop} />,
    );
    expect(h).toContain('role="status"');
    expect(h).toMatch(/<button type="button"[^>]*>復原<\/button>/);
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

  it('TextInput 與 Select 固定同高，Select 取消系統外觀並有自己的箭頭', () => {
    const input = html(<TextInput value="" onChange={noop} />);
    const sel = html(
      <Select value="a" onChange={noop}>
        <option value="a">A</option>
      </Select>,
    );
    expect(input).toContain('h-9');
    expect(sel).toMatch(/<select[^>]*class="[^"]*appearance-none[^"]*h-9/);
    expect(sel).toContain('<svg');
    expect(html(<TextInput size="sm" value="" onChange={noop} />)).toContain('h-7');
  });

  it('Field required 顯示必填標記並設定 aria-required', () => {
    const h = html(
      <Field label="標題" required>
        <TextInput value="" onChange={noop} />
      </Field>,
    );
    expect(h).toContain(t('field.requiredMark'));
    expect(h).toContain('aria-required="true"');
  });

  it('停用的主按鈕改用 line 底色', () => {
    expect(html(<Button disabled>存</Button>)).toContain('disabled:bg-line');
  });
  it('ConfirmDialog 為 alertdialog，說明以 Markdown 顯示，簽署條文未勾選前不能確認', () => {
    const h = html(
      <ConfirmDialog
        title="開啟？"
        body={'**注意**\n\n- 一\n- 二'}
        acknowledge="我同意"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(h).toContain('role="alertdialog"');
    expect(h).toContain('aria-describedby=');
    expect(h).toContain('<strong>注意</strong>');
    expect(h).toContain('<li>一</li>');
    expect(h).toContain('我同意');
    // 主按鈕（最後一個按鈕）停用
    const last = h.slice(h.lastIndexOf('<button'));
    expect(last).toContain('disabled=""');
  });

  it('動作列固定在底部：內容之後、在 form 內，上緣分隔線（D63）', () => {
    const h = html(
      <Dialog
        title="編輯"
        onClose={noop}
        onSubmit={noop}
        footer={
          <DialogFooter start={<Button variant="danger">刪除</Button>}>
            <Button variant="secondary">取消</Button>
            <Button type="submit">儲存</Button>
          </DialogFooter>
        }
      >
        <p>內容</p>
      </Dialog>,
    );
    const body = h.indexOf('內容');
    const foot = h.indexOf('data-dialog-footer');
    expect(foot).toBeGreaterThan(body);
    expect(h.indexOf('</form>')).toBeGreaterThan(foot);
    expect(h.slice(foot)).toContain('border-t border-line');
    // 只有內容區捲動
    expect(h.slice(0, body)).toContain('scroll-panel');
    expect(h.slice(foot)).not.toContain('scroll-panel');
    // 刪除在左、取消在主動作之前
    expect(h.indexOf('刪除')).toBeLessThan(h.indexOf('取消'));
    expect(h.indexOf('取消')).toBeLessThan(h.indexOf('儲存'));
  });

  it('破壞性確認：主按鈕紅底實心、取消白底細框且預設聚焦（D63）', () => {
    const h = html(<ConfirmDialog title="刪除？" tone="danger" onConfirm={noop} onCancel={noop} />);
    const foot = h.slice(h.indexOf('data-dialog-footer'));
    const [cancel, confirm] = foot.split('<button').slice(1);
    expect(cancel).toContain('border-line bg-surface');
    expect(cancel).toContain(t('common.cancel'));
    expect(confirm).toContain('bg-danger');
    expect(confirm).toContain('text-on-primary');
    expect(html(<Button variant="destructive">刪</Button>)).toContain('bg-danger');
  });

  it('NoticeDialog 依等級標示文字，警告與錯誤為 alertdialog', () => {
    const info = html(<NoticeDialog title="完成匯入" level="success" onClose={noop} />);
    expect(info).toContain('role="dialog"');
    expect(info).toContain(t('notice.level.success'));
    const bad = html(<NoticeDialog title="無法啟動" level="danger" body="x" onClose={noop} />);
    expect(bad).toContain('role="alertdialog"');
    expect(bad).toContain(t('notice.level.danger'));
  });

  it('Markdown：表格、勾選清單、提示框、段落 key、程式碼複製、外部圖片改連結', () => {
    const md = [
      '## 摘要 {#summary}',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '- [x] 完成',
      '',
      '> [!WARNING]',
      '> 小心',
      '',
      '```sql',
      'select 1;',
      '```',
      '',
      '![圖](https://e.com/a.png)',
    ].join('\n');
    const h = html(<Markdown>{md}</Markdown>);
    expect(h).toContain('<table>');
    expect(h).toContain('type="checkbox"');
    expect(h).toContain('id="sec-summary"');
    expect(h).not.toContain('{#summary}');
    expect(h).toContain('callout-warning');
    expect(h).toContain('sql');
    expect(h).not.toContain('<img');
    expect(h).toContain('href="https://e.com/a.png"');
  });

  it('Markdown 目錄只在 doc 且有兩個以上的 key 段落時出現', () => {
    const md = '## 摘要 {#summary}\nA\n\n## 內容 {#content}\nB';
    expect(html(<Markdown toc>{md}</Markdown>)).toContain('href="#sec-content"');
    expect(
      html(
        <Markdown toc variant="chat">
          {md}
        </Markdown>,
      ),
    ).not.toContain('href="#sec-content"');
  });

  it('MarkdownEditor 的 applyEdit：包住、行首、插入區塊', () => {
    expect(applyEdit('abc', 1, 2, { wrap: ['**', '**'] })).toEqual(['a**b**c', 3, 4]);
    expect(applyEdit('a\nb', 0, 3, { line: '- ' })[0]).toBe('- a\n- b');
    expect(applyEdit('x', 1, 1, { block: () => 'T' })[0]).toBe('x\n\nT');
  });

  it('Markdown 不轉譯原始 HTML，連結開新視窗', () => {
    const h = html(<Markdown>{'<b>x</b> [a](https://e.com)'}</Markdown>);
    expect(h).not.toContain('<b>');
    expect(h).toContain('target="_blank"');
  });
  it('EmptyState 有插畫（aria-hidden）、loading 時改顯示骨架', () => {
    const h = html(<EmptyState art="tasks">沒有任務</EmptyState>);
    expect(h).toContain('<svg');
    expect(h).toContain('aria-hidden="true"');
    expect(h).toContain('沒有任務');
    expect(html(<EmptyState art="none">x</EmptyState>)).not.toContain('<svg');
    const l = html(<EmptyState loading>沒有任務</EmptyState>);
    expect(l).toContain('role="status"');
    expect(l).toContain('aria-busy="true"');
    expect(l).not.toContain('沒有任務');
  });

  it('Skeleton 以 status 標示載入中，掃光使用 hills-shimmer', () => {
    const h = html(<Skeleton variant="board" count={4} />);
    expect(h).toContain(`aria-label="${t('common.loading')}"`);
    expect(h).toContain('hills-shimmer');
  });
});
