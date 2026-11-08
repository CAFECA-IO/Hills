# Hills 設計系統

> 版本：v0.2 · 2026-11-09 · 對應 [feature-plan.md](./feature-plan.md) v1.15（D22、D40、D43、D45）
> 本文件定義視覺基礎：原則、token、字級、間距、圓角、陰影、層級、動態、無障礙、圖示與列印。通用元件的規格見 [components.md](./components.md)；畫面結構與流程見 [ui-spec.md](./ui-spec.md)。
> 實作來源：`apps/desktop/src/styles/tokens.css`（token）、`apps/desktop/src/ui/`（元件）。三者不一致時以本文件為準，並修正程式碼。

## 1. 原則

1. **畫面只組合通用元件與 token**：`src/ui/` 以外不得直接寫原生互動元素（button、input、select、textarea），不得寫死色碼、任意字級、任意圓角或陰影（§10 的 lint 規則會擋下）。缺少的元件先補 components.md，再加到 `src/ui/`。
2. **每頁只有一個主按鈕**（晴藍實心 `primary`）；其他動作用次要樣式。
3. **狀態不只靠顏色**：狀態一律同時有顏色 + 形狀或圖示 + 文字（ui-spec「視覺語言」狀態表）。
4. **整頁不捲動**（D43）：外框等於視窗高度，只有面板內的清單各自捲動（`.scroll-panel`）。
5. **資訊密度優先**（D45）：以 1280 × 720 為基準設計，大螢幕多顯示內容，字級不放大。
6. **深淺色都要可用**：每個 token 都有淺色與深色值；新增 token 時兩者都要定義並通過對比檢查。
7. **可客製**（D20、D22）：組織只能覆寫主題色（`--hills-primary` 系列），其他 token 不開放覆寫。

## 2. 色彩

所有顏色以 CSS 變數 `--hills-*` 定義在 `tokens.css`，再以 `@theme inline` 對應成 Tailwind class。元件只寫 class（例如 `bg-surface`），不寫變數值，更不寫色碼。

### 2.1 語意色（介面）

| Tailwind | 變數 | 淺色 | 深色 | 用途 |
|---|---|---|---|---|
| `bg-bg` | `--hills-bg` | `#F3F6FA` 晨霧 | `#0F1620` | 視窗底色、hover 底色、程式碼底色 |
| `bg-surface` | `--hills-surface` | `#FFFFFF` | `#18212D` | 卡片、對話框、輸入框、名牌 |
| `text-fg` | `--hills-text` | `#16202E` | `#E8EDF4` | 內文 |
| `text-muted` | `--hills-muted` | `#3B4656` | `#A9B4C3` | 次要文字、標籤、空狀態 |
| `border-line` / `bg-line` | `--hills-border` | `#DCE3EC` | `#2A3646` | 邊框、分隔線、進度條底 |
| `bg-primary` / `text-primary` | `--hills-primary` | `#1F6FEB` 晴藍 | `#4C8DF6` | 主按鈕、選取、連結、焦點環；**組織可覆寫** |
| `text-on-primary` | `--hills-on-primary` | `#FFFFFF` | `#0F1620` | 主色底上的文字（深色模式改深色字以達對比） |
| `bg-primary-soft` | `--hills-primary-soft` | `#E6F0FE` 天空霧 | `#1B2B45` | 選取列、聚焦卡、柔和按鈕 |
| `text-danger` / `border-danger` | `--hills-danger` | `#B42328` | `#FF8A8E` | 錯誤、刪除、不可逆動作 |
| `text-warning` | `--hills-warning` | `#8A5A00` | `#F5C35A` | 提醒、待處理 |
| `bg-qr` | `--hills-qr-bg` | `#FFFFFF` | `#FFFFFF` | QR Code 底（一律白底以便掃描） |

遮罩用 `bg-fg/20`（內文色 20% 透明），不另設 token。

### 2.2 插畫與資料視覺

| 群組 | 變數 | 用途 | 規則 |
|---|---|---|---|
| 山景 | `--hills-sky-top/-bottom`、`--hills-mountain`、`--hills-hill-near/-mid/-far` | 首頁焦點山、山丘 | 只用於插畫 |
| 知識庫星空 | `--hills-night-top/-bottom`、`--hills-night-text`、`--hills-star`、`--hills-star-dim` | 星空背景、星星、星空上的文字 | 深淺色模式相同 |
| 知識關聯 | `--hills-rel-ref/-topic/-task/-conv` | 星座連線、關聯膠囊邊框 | 一律搭配線型（實線 / 虛線 / 點線）與圖例 |
| 目標層級 | `--hills-level-year/-quarter/-month/-week/-day`（`bg-level-*`、`text-level-*`） | 層級標記、進度環、進度條 | 一律搭配層級文字 |
| 狀態 | `--hills-st-<狀態>`（徽章色）、`--hills-st-<狀態>-text`（文字色，對 surface ≥ 4.5 : 1） | Presence 徽章、狀態文字、成功 / 進行中標示 | 搭配徽章形狀與文字（ui-spec 狀態表） |
| 角色 | `--hills-ink*`、`--hills-cloud`、`--hills-sun*`、`--hills-moon*`、`--hills-roof`、`--hills-laptop*`、`--hills-hair-0…7`、`--hills-shirt-0…7`、`--hills-skin-0…7` | 原創簡筆角色與天空裝飾 | 只用於 `figures.tsx` 等插畫；成員從色盤選擇（`team.rs` 的 `LOOK_PALETTE` = 8） |

SVG 插畫用 `var(--hills-*)` 指定 `fill` / `stroke`（`figures.tsx`、`home.tsx` 的 `v()` 函式），不寫色碼。

完整色值見 ui-spec「視覺語言」色彩表與 `tokens.css`；新增 token 時兩處同步。

## 3. 字級（D45）

以 1280 × 720 的資訊密度為準；字級不隨解析度放大（≥ 1600 寬只有頂列標題放大一級）。

| 角色 | Tailwind | 大小 / 行高 | 字重 | 用在 |
|---|---|---|---|---|
| 大數字 | `text-3xl` | 30 / 36 | 400（等寬） | 登入碼等單一大數字 |
| 歡迎標題 | `text-2xl` | 24 / 32 | 600 | 初次啟動流程（`Centered`） |
| 頁面標題 | `text-lg`（`wide:text-xl`） | 18 / 28 | 700 | 頂列 `PageHead` |
| 對話框標題、卡片大標 | `text-lg` | 18 / 28 | 700 | `Dialog` 標題、焦點卡 |
| 卡片標題 | `text-base` | 16 / 24 | 700 | `Card` 內 h2 / h3 |
| 內文 | `text-sm` | 14 / 20 | 400 | 清單、表單、訊息、按鈕 |
| 註解、標籤 | `text-xs` | 12 / 16 | 400–700 | 欄位標籤、時間、說明、`SectionLabel` |
| 徽章 | `text-2xs` | 11 / 16 | 400–700 | `Badge`、步驟編號、圖例 |

- 字型：Inter + Noto Sans TC（若系統已安裝），否則系統字型；安裝檔不打包字型（D40）。程式碼與 Markdown 原文用 `font-mono`。
- 字重只用 400、500（`font-medium`）、600（`font-semibold`）、700（`font-bold`）。
- 不用任意字級（`text-[13px]`）；確實需要新級距時先改本表。

## 4. 間距與尺寸

- **4 px 網格**：只用 Tailwind 間距刻度（`1` = 4 px）。常用：元件內 `gap-1`–`gap-2`、區塊間 `gap-3`（`wide:gap-4`）、卡片內距 `p-4` / `p-5`、頁面外距見 ui-spec「版面」。
- **控制項高度**：一般 36（`h-9`：Button md、輸入框與下拉選單 md、頂列動作）、小 28（`h-7`：Button sm、輸入框與下拉選單 sm、膠囊）。輸入框與下拉選單以固定高度實作，不靠上下內距（WebKit 會忽略原生 select 的內距）。觸控目標 ≥ 44（行動端）。
- **固定寬度**：用間距刻度（`w-80` = 320、`w-140` = 560），不用 `w-[560px]`。對話框寬度只用 `Dialog` 的 sm 480 / md 560 / lg 600。版面欄寬見 ui-spec「版面」。

## 5. 圓角、陰影、層級

| 類型 | Tailwind | 值 | 用在 |
|---|---|---|---|
| 卡片 | `rounded-card` | 16 | Card、Dialog、Popover、場景區 |
| 控制項 | `rounded-control` | 12 | 輸入框、清單列、選單 |
| 膠囊 | `rounded-full` | 999 | 按鈕、Badge、Chip、SegmentedControl、進度條 |
| 小 | `rounded-sm` / `rounded` | 2 / 4 | 可點擊文字的焦點範圍、行內程式碼 |

| 陰影 | 用在 |
|---|---|
| `shadow-sm` | 卡片、頂列膠囊、SegmentedControl |
| `shadow-lg` | 浮層：Dialog、Popover、Menu |

| z 層 | 用在 |
|---|---|
| `z-10` | 場景內的浮動標記 |
| `z-20` | Popover、Menu（錨定在觸發元素旁） |
| `z-40` | Dialog（含遮罩）、指令面板 |

## 6. 版面

依 D43 與 ui-spec「版面」：App 最小 1280 × 720、整頁不捲動、左側圖示列 76（≥ 1600：88）、右欄 280（340）、頂列 52（60）。≥ 1600 寬用 Tailwind 斷點 `wide:`（`--breakpoint-wide: 1600px`）放大欄寬與間距。

面板內捲動一律用 `.scroll-panel`（4 px 捲動條，滑過或聚焦才顯示）。

## 7. 動態

- 時間一律 `duration-(--hills-motion)`（180 ms）；系統開啟「減少動態效果」時為 0。
- 只對顏色、寬度（進度條）、位移（山路角色）做過渡；不做彈跳、縮放進場。
- 慶祝效果（登頂彩帶）可在設定關閉，減少動態時改為靜態圖示（ui-spec「視覺語言」）。

## 8. 無障礙

- **對比**：文字對背景 ≥ 4.5 : 1（WCAG AA）；狀態文字用 `-text` token。停用的主按鈕用 `bg-line` + `text-muted`，不用半透明晴藍（components.md「共通狀態」）。
- **焦點**：所有互動元素有可見焦點環 `focus-visible:outline-2 outline-offset-2 outline-primary`（通用元件已內建，元件常數 `FOCUS_RING`）。
- **鍵盤**：全部功能可用鍵盤完成；浮層開啟時焦點移入、Esc 關閉；切換群組用方向鍵（components.md 各元件「鍵盤」）。
- **名稱**：只有圖示的按鈕必須有名稱（`IconButton` 的 `label` 必填）；裝飾性 SVG 加 `aria-hidden`；數字徽章提供 `label`（例如「3 則未讀」）。
- **狀態不只靠顏色**（§1）；山景、星空等插畫都有清單檢視。

## 9. 圖示與插畫

- 圖示為自繪內嵌 SVG（`viewBox="0 0 20 20"`、線寬 1.6、圓端點），顏色用 `currentColor`；尺寸 14 / 16 / 18 / 20。不引入圖示字型或第三方圖示套件。
- 插畫（角色、山景、星空、月相）只用 §2.2 token；角色為原創簡筆圖形（D40）。
- 文字型符號（`×`、`◀`、`▶`、`✓`、`⚑`）可作為圖示，但必須放在 `IconButton` 或有文字說明的元素內。

## 10. 列印

報表列印只印 `.print-area`（`tokens.css` 的 `@media print`）：黑字白底、12 pt、行高 1.6。列印內容以 `renderToStaticMarkup` 產生 HTML，不印 Markdown 原文。

## 11. 規則與檢查

ESLint（根目錄 `eslint.config.js`，`pnpm lint` 執行）對 `apps/desktop/src/**/*.tsx` 強制下列規則；`src/ui/**`、`figures.tsx`（插畫）、`src/dev/**`、測試檔除外：

| 規則 | 改用 |
|---|---|
| 不得使用原生 `<button>`、`<input>`、`<select>`、`<textarea>` | `Button`、`IconButton`、`LinkButton`、`ListButton`、`Pressable`、`TextInput`、`TextArea`、`Select`、`Checkbox`、`Radio`、`Slider` |
| 字串中不得出現色碼（`#rrggbb`、`rgb(`、`hsl(`） | §2 token |
| 不得使用任意的字級、顏色、圓角、陰影、字距（`text-[…]`、`bg-[…]`、`rounded-[…]`、`shadow-[…]`、`tracking-[…]` 等） | §3–§5 token |
| 不得使用 Tailwind 預設色盤（`bg-blue-500`、`text-gray-…`、`text-white`、`bg-black`） | §2 token |

允許的任意值只有版面計算（`max-h-[90vh]`、`grid-cols-[minmax(0,1fr)_340px]`、`h-[calc(…)]`）。確實需要例外時寫 `// eslint-disable-next-line no-restricted-syntax -- <原因>`，並在 PR 說明；插畫以外不應出現。

**其他人工檢查（PR review）**：

- 文字經 i18n（development-guidelines §4.2）。
- 每頁一個主按鈕；不可逆動作用 `ConfirmButton`。
- 列表有空狀態（`EmptyState`）；失敗有錯誤訊息（`ErrorText`）。
- 1280 × 720 與 1920 × 1080、淺色與深色截圖無整頁捲動、無破版。
- 原生控制項（select、date、time、checkbox）在 Mac（WKWebView）與 Windows（WebView2，Chromium）外觀一致：同一列的輸入框與下拉選單等高、圓角相同。開發環境的自動截圖只有 Chromium，Mac 上需目視確認。
