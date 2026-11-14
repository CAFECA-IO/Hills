import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/boot.css';

// 視窗的拖放交給網頁處理（tauri.conf `dragDropEnabled: false`，分派板、這一週、時間軸的拖曳才會動）。
// 沒有處理的檔案拖進視窗時不讓 WebView 開啟該檔案。
const isFileDrag = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
window.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
