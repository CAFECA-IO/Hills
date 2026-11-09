/** Markdown 內容（components.md「Markdown」v0.6）：不轉譯原始 HTML，連結以外部瀏覽器開啟。 */
import ReactMarkdown from 'react-markdown';

export function Markdown({
  children,
  className = '',
  id,
}: {
  children: string;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={`prose-hills break-words ${className}`}>
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children: c }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline"
            >
              {c}
            </a>
          ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
