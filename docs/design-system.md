# Hills 設計系統

> 版本：v0.10 · 2026-11-10 · 對應 [feature-plan.md](./feature-plan.md) v1.43（D22、D40、D43、D45、D47、D56、D58、D59、D63）
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
| 目標層級 | `--hills-level-year/-quarter/-month/-week/-day`（`bg-level-*`、`text-level-*`） | 層級標記、進度環、進度條；`-day` 用於任務欄（D46 取消日目標） | 一律搭配層級文字 |
| 狀態 | `--hills-st-<狀態>`（徽章色）、`--hills-st-<狀態>-text`（文字色，對 surface ≥ 4.5 : 1） | Presence 徽章、狀態文字、成功 / 進行中標示 | 搭配徽章形狀與文字（ui-spec 狀態表） |
| 啟動動畫 | `--hills-boot-flame-out/-mid/-in`、`--hills-boot-log`、`--hills-boot-glow`（v0.5） | 啟動動畫 F 的營火、木柴、火光（§9） | 只用於啟動動畫；其餘版本重用山景、星空、羅盤、角色、狀態 token |
| 方向羅盤 | `--hills-drift-floor`、`--hills-drift-floor-edge`、`--hills-drift-zone`（`fill-drift-*`） | 方向羅盤的地面、地面厚度、「在路上」扇形（§9） | 狀態另用 `primary`（在路上）、`warning`（可能偏離）、`muted`（太久沒更新）、`level-year`（小組方向），一律搭配形狀與文字 |
| 頭像底色（v0.8，D58） | `--hills-avatar-0…6` | 圓形頭像的底色 | 由成員 ID 決定；只用於頭像 |
| 往山丘走（v0.9，D59） | `--hills-hill-path`、`--hills-hill-path-edge`、`--hills-hill-ground`、`--hills-trail` | 小組方向山丘場景的小路、小路邊線、草地、足跡（§9） | 重用山景 token；角色狀態另用 `st-online`（在路上）、`primary`（走太慢）、`warning`（方向歪了）、`danger`（往後退）、`muted`（停下來），一律搭配形狀與文字 |
| 角色 | `--hills-ink*`、`--hills-cloud`、`--hills-sun*`、`--hills-moon*`、`--hills-roof`、`--hills-laptop*`、`--hills-shirt-0…5`、`--hills-look-<kind>-<part>-0…5`（v0.7，D56） | 七種角色與天空裝飾 | 只用於 `characters.tsx`、`figures.tsx` 等插畫；`kind` 為 `man`、`woman`、`cat`、`dog`、`elephant`、`sheep`、`tiger`，`part` 為 `a`（部位 1）、`c`（部位 3），衣服共用 `--hills-shirt-*`；成員從色盤選擇（`team.rs` 的 `LOOK_PALETTE` = 6）；角色固定色（筆電、腳底、口鼻白、眼睛、腮紅）用 `--hills-char-*` |
| 晨光山丘（v0.7，D56） | `--hills-dawn-top/-upper/-lower/-bottom`、`--hills-dawn-sun`、`--hills-dawn-hill-far/-mid/-near` | 設定頁背景；深色模式為夜晚（沿用星空 token 的色調） | 只用於背景插畫 |
| 毛玻璃（v0.7，D56） | `--hills-glass`、`--hills-glass-strong`、`--hills-glass-line`、`--hills-glass-shadow`；`backdrop-blur` 18 px | `GlassPanel`、`GlassScope` 內的 `Card`、設定頁的分組膠囊與箭頭 | 只放在插畫背景上；模糊畫在內容後面的兄弟層（`GlassLayer`），不要把 `backdrop-filter` 加在含對話框的容器上（會讓 `position: fixed` 錯位）；玻璃上的文字用 `text` / `muted` 並確保 ≥ 4.5 : 1；`prefers-reduced-transparency: reduce` 時改為 `surface` 實色、不模糊 |

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

### 5.1 浮動視窗的動作列（v0.10，D63）

適用：`Dialog`、`ConfirmDialog`、`NoticeDialog`、有確認 / 取消的 `Popover`（例如資料夾分享摘要）、AI 代理確認卡。實作一律用 `DialogFooter`（`Dialog` 以 `footer` 傳入），不在各頁手寫按鈕列。

```
┌──────────────────────────────────────────┐
│ 標題                                   × │  固定
├──────────────────────────────────────────┤
│ 內容（過長時只有這一段捲動）              │
├──────────────────────────────────────────┤  1 px line
│ [刪除]                  [取消] [■ 儲存 ■] │  固定在底部
└──────────────────────────────────────────┘
```

| 規則 | 內容 |
|---|---|
| 位置 | 動作**一律在視窗底部的動作列**；內容超過最大高度時只捲動中間內容，標題與動作列固定。動作列上緣 1 px `line` 分隔線，內距同對話框（20） |
| 順序 | 右對齊：`取消`（次要）在左、主動作在最右。破壞性的**附帶**動作（例如編輯對話框裡的「刪除」）放動作列**最左**，與主要動作分開 |
| 主動作 | **實心**：一般用 `primary`（晴藍底、`on-primary` 字）；確認不可逆動作（刪除、移除、停用）用 `destructive`（`danger` 底、`on-primary` 字） |
| 取消 | 一律 `secondary`（`surface` 底、`line` 細框、`fg` 字）；不用彩色、不用 `ghost` 或連結樣式 |
| 數量 | 一個動作列**只有一個實心按鈕**；第三個動作用 `secondary`，附帶的破壞性入口用 `danger`（紅框） |
| 焦點與鍵盤 | 一般確認預設聚焦主動作；破壞性確認預設聚焦「取消」；Esc = 取消；表單對話框 Enter = 主動作 |
| 「放棄未儲存的修改？」 | `dirty` 時的詢問列出現在動作列上方，同樣固定在底部 |

## 6. 版面

依 D43 與 ui-spec「版面」：App 最小 1280 × 720、整頁不捲動、左側圖示列 76（≥ 1600：88）、右欄 280（340）、頂列 52（60）。≥ 1600 寬用 Tailwind 斷點 `wide:`（`--breakpoint-wide: 1600px`）放大欄寬與間距。

面板內捲動一律用 `.scroll-panel`（4 px 捲動條，滑過或聚焦才顯示）。

## 7. 動態

- 時間一律 `duration-(--hills-motion)`（180 ms）；系統開啟「減少動態效果」時為 0。
- **介面元件**（按鈕、對話框、選單、Toast、列表、卡片）：只對顏色、寬度（進度條）、位移做過渡；不做彈跳、縮放進場。理由：整天使用的工作工具要俐落，元件反覆出現時彈跳會讓人覺得慢；縮放與彈跳最容易引起前庭不適；縮放中的文字在 WebView 會短暫模糊。
- **插畫動畫**（v0.5）：只出現一次、不擋操作的裝飾插畫，目前有啟動動畫（§9「啟動動畫」）、登頂彩帶與方向羅盤進場（D47 第 5 批），可以使用彈跳、縮放與循環。限制：
  - 不用在任何互動元件上；
  - 不為了播放動畫延長等待（例如啟動完成就立即切換）；
  - 有文字的部分（字標、標籤、狀態文字）不縮放；
  - 系統開啟「減少動態效果」時顯示靜態的完成畫面。
- 慶祝效果（登頂彩帶）可在設定關閉，減少動態時改為靜態圖示（ui-spec「視覺語言」）。
- **角色動畫**（v0.7，D56）：角色原地踏步（兩腿交替抬起 8 單位、身體微微下沉，1 秒循環，CSS keyframes `hills-step-a/-b`、`hills-body`），屬插畫動畫；減少動態時靜止站立。設定的角色舞台切換：舊角色往切換方向的反方向位移 28 px 並淡出（240 ms），新角色從另一側淡入；減少動態時直接替換。
- **載入骨架**（v0.6）：資料還沒載入時，以 `Skeleton` 畫出內容的大致形狀（文字列、清單列、卡片、看板欄），上面一道淡光由左往右掃過（1.4 秒循環，CSS 位移動畫）。骨架只用 `line`、`bg` token；不用轉圈圖示，也不先顯示空狀態再跳成內容。減少動態時不掃光、只顯示靜態骨架。

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

### 圓形頭像（v0.8，D58）

- **取景**：同一個角色（`characters.tsx`）只取頭與肩，頭部中心在圓的上方約 40%；耳朵、頭髮可超出頭但不超出圓。
- **尺寸**：72（名片）、64（團隊卡片）、44（對話頂列）、40（對話列表、團隊清單）、36（訊息）、22–27（系統列、交疊、負責人）。
- **底色**：`--hills-avatar-0…6`，由成員 ID 的雜湊選一個，每人固定；深色模式另有一組。
- **狀態徽章**：右下角，與場景相同的形狀（`BadgeShape`）與 `--hills-st-*` 色，白邊（`surface`）；尺寸 ≤ 24 時不畫。
- **我**：`primary` 外圈；**離線**：整顆 55% 透明。
- **AI Agent（D54）**：專屬機器人（螢幕臉、天線、胸前燈），頭像為圓角方形（圓角 = 邊長 30%）加右上「AI」標籤（≥ 32 px）；臉隨狀態變化（執行中亮眼、閒置瞇眼、已暫停「‖」、離線全暗）。一般成員不能選機器人。
- 列表中的頭像不播放踏步動畫。

### 空狀態插畫（v0.6）

每個空狀態都有一張小插畫（`EmptyState art`，components.md），讓「這裡還沒有東西」一眼看懂，也和「載入中」的骨架分得開。

- 尺寸 120 × 80，置中於說明文字上方；線稿為主：輪廓 `line`、強調一筆 `primary`、底色 `bg`；深淺色共用 token，不另做。
- 種類：`generic`（山丘與虛線旗桿）、`goals`（階梯與旗子）、`tasks`（清單與勾選）、`chat`（兩個對話泡泡）、`knowledge`（三顆星連線）、`team`（兩個角色輪廓）、`report`（文件與折角）。新頁面先用最接近的一種，不夠用再在本節新增。
- 裝飾性：`aria-hidden`，意思由下方的說明文字表達；不加動畫。

### App 圖示（v0.3）

圖案為「山丘」（D22）：綠色天空漸層（`#3AA07E` → `#2A8063`）、白色主山與淡綠後山（`--hills-hill-mid`）。依各作業系統規範有兩份來源，放在 `apps/desktop/src-tauri/icons/source/`：

| 來源 | 平台 | 規格 |
|---|---|---|
| `app-icon-macos.svg` | macOS（`icon.icns`） | Apple 圖示格線：1024 畫布，主體 824 × 824 置中（四周透明留 100），圓角 185（約 22.5%），下方陰影（y 10、模糊 12、黑 28%）。不可滿版，否則在 Dock 與 Launchpad 中比其他 App 大且沒有圓角 |
| `app-icon.svg` | Windows（`icon.ico`、`Square*Logo.png`、`StoreLogo.png`）、Linux（`*.png`） | 1024 畫布，主體四周留 64，圓角 176，不加陰影（由系統處理） |

重新產生：`pnpm --filter @hills/desktop tauri icon src-tauri/icons/source/app-icon.svg -o <暫存>` 後把頂層檔案（不含 android、ios）複製到 `icons/`，再以 `app-icon-macos.svg` 產生一次並只取 `icon.icns` 覆蓋。修改圖案時兩份來源一起改。

### 啟動動畫（v0.5）

ui-spec「啟動畫面」使用的插畫動畫（§7「插畫動畫」），共六個版本，每次啟動隨機一個（不重複上次）：

| 版本 | 內容 | 狀態文字 |
|---|---|---|
| A 日出山丘 | 遠、中、近三層山丘依序升起，太陽浮出後光暈呼吸，中山升起小旗，雲飄過 | 正在同步你的組織 |
| B 登頂小旗 | 虛線山徑從山腳畫到山頂，角色沿路往上，步驟點 1–3 依序亮起，到頂升旗 | 正在準備今天的山 |
| C 方向羅盤 | 傾斜的羅盤地面（同下方「方向羅盤」投影），四位成員的人像依序落下並擺進綠色扇形，畫出大家實際走向，地面泛起紫色波紋 | 依階段：正在連線組織 → 正在同步每個人的方向 → 大家都在路上 |
| D 知識星座 | 星圖（天球圈與經線）緩慢擺動，三個分類星座依序亮星、連線、浮現分類名，流星劃過；底色用知識庫星空 token，深淺色相同 | 正在整理大家的知識 |
| E 加密分片拼合 | Hills 圖示切成 8 條分片從四周飛回，第 5 片到位時鎖扣上，光掃過，附「8 片分片，取回任意 5 片即可還原」 | 正在解密並同步 |
| F 營火集合 | 山頂營火晃動、冒火星，五位成員依序從坡下彈上圍坐並亮起上線點 | 正在聚集你的團隊 |

共通規格：插畫 360 × 220（C 為 400 × 260）、圓角 20，下方 Hills 字標（28 / 700）、「山丘上的卡菲卡」（14，`muted`）與狀態文字（13，`muted`，後接三個依序閃爍的點）；循環 4–6 秒；插畫 `aria-hidden`，狀態文字 `role="status"`。

### 方向羅盤（v0.4，D47）

ui-spec「目標 → 團隊」D7 等畫面的資料視覺：

- **地面**：半圓盤，先在平面上旋轉 −5°（大）/ −7°（小）再垂直壓扁為 0.78 / 0.58，表現微微傾斜的透視；前緣加 8 px（迷你版 3 px）厚度（`drift-floor-edge`）。線條用 `vector-effect: non-scaling-stroke`，壓扁後粗細不變。
- **刻度**：25 / 50 / 75 / 100% 進度環（`line`）、今天應到的虛線弧（`fg` 50%）、綠色扇形 ±45°（`drift-zone`，由中心往外漸淡）。
- **小組方向**：紫色（`level-year`）粗箭頭，終點是小山加旗子。
- **成員**：每人一條線（6 px 我 / 3 px 他人），在路上 = `primary`、可能偏離 = `warning`、太久沒更新 = `muted` 點線、目標沒對齊 = 虛線。尖端是圖釘（地面陰影 + 細線）立著的頭肩像（直徑 36，我 44），外框顏色同狀態、右上角徽章 ✓ / ▲ / 時鐘；人像重疊時左右推開，圖釘線斜著連回地面點。
- **三種尺寸**：完整版（D7，含標籤與人像）、「我」版（只畫我與小組，右欄）、迷你版（110 × 52，只有圓點，小組列）。
- 人像是按鈕：滑過 / 聚焦放大 8% 並顯示 `Tooltip`；`prefers-reduced-motion` 時不做動畫。
- 圖上一律有文字（名字、偏幾度、今天應到 N%），顏色不是唯一的訊息。

### 往山丘走（v0.9，D59）

ui-spec「工作 › 小組 › 方向」的遊戲畫面，取代方向羅盤作為小組方向的預設呈現（羅盤保留給「你的方向」小卡）：

- **場景**：天空、遠山（`hill-far`）、正前方的主山（`mountain`，雪頂與小組目標旗子，旗色 `level-year`）；草地（`hill-ground`）上一條往山頂收窄的小路（`hill-path`，兩側虛線 `hill-path-edge`），代表偏 45° 以內；橫越小路的虛線是「今天應到」，右端帶深色標籤；底部「季初出發」。
- **角色**：D56 的角色（頭肩到腳），越遠越小（依 y 縮放 0.7–1）；腳下地面陰影。位置：往前 = 季目標進度（`quarterProgress`），左右 = 角度（離開小路 = 偏 45° 以上）。
- **狀態**（形狀 + 文字 + 顏色，不只靠顏色）：在路上（頭上綠色 ▲ 小旗）、走太慢 ▼（`primary` 標籤，足跡很密）、方向歪了 ▲（`warning` 標籤，足跡走出小路、身體朝側邊）、往後退 ↓（`danger` 標籤，朝起點走）、停下來 ◷（`muted` 灰色角色與「z z」）；休假的人在左上角的雲上，不列入。
- **足跡**：前三週的位置以 3–3.5 px 圓點（`trail`，越舊越淡）連到現在的位置；「四週足跡」開關可關。
- 角色是按鈕：滑過 / 聚焦放大 8% 並顯示摘要 `Tooltip`；`prefers-reduced-motion` 時角色不做踏步動畫。
- 場景上一律有名字與狀態文字；「用表格看」切到表格檢視（四項檢查與四週趨勢），作為無障礙替代。

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
- 對話框與浮動面板的動作在底部動作列（`DialogFooter`）：取消在左（白底細框）、主動作在最右（實心），一列只有一個實心按鈕（§5.1）。
- 列表有空狀態（`EmptyState`）；失敗有錯誤訊息（`ErrorText`）。
- 1280 × 720 與 1920 × 1080、淺色與深色截圖無整頁捲動、無破版。
- 原生控制項（select、date、time、checkbox）在 Mac（WKWebView）與 Windows（WebView2，Chromium）外觀一致：同一列的輸入框與下拉選單等高、圓角相同。開發環境的自動截圖只有 Chromium，Mac 上需目視確認。
