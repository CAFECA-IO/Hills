/** 列印 / 存成 PDF（design-system §10）：把 Markdown 轉成 HTML 放進列印區，呼叫系統列印對話框。 */
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './ui';

export function printMarkdown(md: string) {
  const area = document.createElement('div');
  area.className = 'print-area prose-hills';
  // react-markdown 不轉譯原始 HTML（skipHtml），輸出可安全放入
  area.innerHTML = renderToStaticMarkup(<Markdown>{md}</Markdown>);
  document.body.appendChild(area);
  const done = () => {
    area.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  // 部分 WebView 不會觸發 afterprint
  setTimeout(done, 60_000);
}
