# Hills 通用元件

> 版本：v0.10 · 2026-11-09 · 對應 [feature-plan.md](./feature-plan.md) v1.37（D45、D47、D56）
> 本文件定義 `apps/desktop/src/ui/` 的通用元件：用途、何時用、變體、狀態、鍵盤與無障礙、API。視覺基礎（token、字級、間距）見 [design-system.md](./design-system.md)。
> 畫面只能組合這些元件（design-system §1、§11）。需要新元件或新變體時，**先改本文件，再改 `src/ui/`**，並補 `src/ui/ui.test.tsx`。

匯入一律 `import { … } from './ui'`（`src/ui/index.ts`）。所有元件都把其餘原生屬性（`aria-*`、`data-*`、`disabled`、`onKeyDown`…）傳給底層元素，並接受 `className` 做**版面**調整（寬度、對齊、外距）；不要用 `className` 改顏色、字級或圓角——需要的話新增變體。

## 共通狀態

| 狀態 | 表現 |
|---|---|
| hover | 次要元件改 `bg-bg` 底或 `text-fg` / `text-primary` 字 |
| focus | `FOCUS_RING`：2 px 主色外框、offset 2（只在鍵盤聚焦時顯示） |
| disabled | 50% 透明、`cursor-not-allowed`；主按鈕改為 `bg-line` 底 `text-muted` 字（半透明的晴藍對比不足） |
| busy | `Button busy`：停用 + `aria-busy` |
| error | 輸入框 `invalid`（或包在有 `error` 的 `Field` 內）：紅框 + `aria-invalid` |
| selected | 天空霧底 `bg-primary-soft` + 主色字（清單列、膠囊切換為主色實心） |

---

## 1. 按鈕

### Button

文字按鈕。預設 `type="button"`（表單送出要明寫 `type="submit"`）。

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `variant` | `primary` \| `secondary` \| `soft` \| `danger` \| `ghost` | `primary` | 見下表 |
| `size` | `sm` \| `md` | `md` | md 高 36、sm 高 28 |
| `busy` | boolean | false | 執行中：停用並標示 `aria-busy` |

| 變體 | 外觀 | 何時用 |
|---|---|---|
| `primary` | 晴藍實心 | 這一頁 / 這個對話框最主要的一個動作（每頁一個） |
| `secondary` | 白底細框 | 一般動作、取消、期間切換 |
| `soft` | 天空霧底主色字 | 建議動作、目前選取的選項（例如「不設定」回來時間） |
| `danger` | 紅框紅字，hover 紅底 | 刪除、移除；不可逆時改用 `ConfirmButton` |
| `ghost` | 無框灰字 | 面板底部的次要新增、工具列內不顯眼的動作 |

不要用：只有圖示時（用 `IconButton`）、行內文字連結（用 `LinkButton`）、整列可點的清單項目（用 `ListButton`）。

### IconButton

只有圖示的按鈕。**`label` 必填**，同時作為 `aria-label` 與滑過提示。

| prop | 型別 | 預設 |
|---|---|---|
| `label` | string（必填） | — |
| `variant` | `ghost` \| `secondary` \| `soft` | `ghost` |
| `size` | `sm` \| `md` | `md`（36 × 36；sm 28 × 28） |

用在：關閉（×）、上一期 / 下一期（◀ ▶）、上移 / 下移、附加檔案、刪除單列。

### LinkButton

外觀像文字連結的按鈕：不離開目前畫面的次要動作（「預覽」「回到現在」「開啟對話」「重新命名」）。

| prop | 型別 | 預設 |
|---|---|---|
| `tone` | `primary` \| `muted` \| `danger` | `primary` |

需要底線時加 `className="underline"`。真正開外部網址的連結用 `<a>`（目前只有開發工具連結）。

### ListButton

清單中的可選列（對話清單、任務選擇、知識清單）：整列可點、hover 底色、圓角 12。

| prop | 型別 | 說明 |
|---|---|---|
| `selected` | boolean | 天空霧底 + 主色粗體，並設定 `aria-current="true"` |

內容預設左對齊、`gap-2`；兩端對齊加 `className="justify-between"`。

### Pressable

沒有預設外觀的可點擊表面，只提供 button 語意、`type="button"`、左對齊與焦點環。用在外觀特殊、無法用上面元件表達的互動區：導覽列項目、目標卡、成員角色、色票、星空連結、可展開的列。外觀由呼叫端用 token class 決定。

能用 `Button` / `ListButton` / `Chip` 的地方不要用 `Pressable`。

---

## 2. 表單

### Field

表單欄位：標籤（12 / 500 / muted）+ 控制項 + 說明 + 錯誤。

| prop | 型別 | 說明 |
|---|---|---|
| `label` | ReactNode | 標籤文字 |
| `hint` | ReactNode | 欄位下方說明 |
| `error` | string \| null | 錯誤訊息（`role="alert"`），同時讓控制項變紅框 |
| `required` | boolean | 標籤後顯示「（必填）」，控制項加 `aria-required`。只做標示，驗證在送出時進行（§7「表單對話框」） |
| `children` | ReactNode | 一個 `TextInput` / `TextArea` / `Select`：自動取得 `id`、`aria-describedby`、`aria-invalid` |

簡易寫法（不傳 children）：`<Field label value onChange type? multiline? placeholder? autoFocus? />` 直接產生文字輸入（`multiline` 為等寬字多行）。

一組核取方塊 / 單選用 `<fieldset>` + `<legend className="text-xs font-medium text-muted">`，不要用 `Field`。

### TextInput、TextArea、Select

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `size` | `sm` \| `md` | `md` | **固定高度**：md 36（`h-9 px-3`）、sm 28（`h-7 px-2`）；TextArea 只套水平內距，高度由 `rows` 決定 |
| `invalid` | boolean | — | 紅框；在 `Field` 內由 `error` 自動決定 |
| `appearance` | `boxed` \| `bare` | `boxed` | `bare`：無框透明，只用在已有外框的容器內（指令面板搜尋列）。`Select` 無此項 |

- `TextInput` 涵蓋 text、password、search、number、time、datetime-local。
- `Select` 是原生 select（保留系統鍵盤與螢幕閱讀器行為），但**取消系統外觀**（`appearance-none`）並畫自己的箭頭，讓 Mac（WebKit 會忽略原生 select 的內距與高度）與 Windows 上的高度、圓角、外框一致。`className` 套在外層（版面：寬度、flex），不是 select 本身。
- 沒有可見標籤時必須給 `aria-label`。

### Checkbox、Radio

| prop | 型別 | 說明 |
|---|---|---|
| `label` | ReactNode | 有 label 時整列（`<label>`）可點；`className` 套在整列上 |

沒有 `label` 時是單獨的方塊，必須放在 `<label>` 內或給 `aria-label`。同一組 `Radio` 用相同 `name`。

### Slider

原生 range。必須給 `aria-label` 與 `aria-valuetext`（例如時間軸的週次）。

### Switch（v0.5）

左右滑動的功能開關：開或關之後**立即生效**的設定或檢視（不需要再按儲存）。滑軌 36 × 20（`sm` 28 × 16），開 = `primary` 底、圓鈕在右；關 = `line` 底、圓鈕在左；圓鈕 `surface`。圓鈕以 `--hills-motion` 滑動，`prefers-reduced-motion` 時不做動畫。

| prop | 型別 | 說明 |
|---|---|---|
| `checked` | boolean | 受控 |
| `onChange` | `(checked: boolean) => void` | |
| `label` | ReactNode | 選填；有 label 時文字在左、開關在右，整列可點 |
| `description` | ReactNode | 選填；label 下方的說明（以 `aria-describedby` 連結） |
| `size` | `'sm' \| 'md'` | 預設 md |
| `disabled` | boolean | |

無障礙：`role="switch"`、`aria-checked`；沒有 label 時必須給 `aria-label`。鍵盤：Tab 聚焦、Space / Enter 切換。

**Checkbox、Switch、Chip 怎麼選**：

| 情境 | 元件 | 例子 |
|---|---|---|
| 立即生效的設定或檢視 | Switch | 目標頁「進階檢視」、路線圖「只看我的」、報表「小組彙整」 |
| 表單裡、按「儲存」才生效的選項 | Checkbox | 目標編輯「手動設定進度」、核准加入「設為管理者」 |
| 多選清單 | Checkbox | 發佈到哪些小組、選擇聊天成員、知識引用 |
| 標示完成 | Checkbox | 任務步驟、這一週清單 |
| 確認同意 | Checkbox | 還原頁「我了解」 |
| 一列選填條件，按了就套用 | Chip | 這一週新增列的「哪一天？」「只有我看得到」 |

### ChoiceCard（v0.3，D47）

大面積的單選卡片：精靈中「選一個方向 / 目標」這種選項需要標題＋說明＋標記時使用（引導式規劃、設定小組方向）。選項只有短文字時用 Radio。

| prop | 型別 | 說明 |
|---|---|---|
| `label` | string | 群組名稱（`role="radiogroup"` 的 `aria-label`） |
| `options` | `{ value, title, description?, badge?, dashed? }[]` | `dashed`：虛線外框的「都不是」選項 |
| `value`、`onChange` | 受控；`value` 可為 null（尚未選） |

每張卡是 `role="radio"`、`aria-checked`；只有選取的卡（或未選時第一張）可 Tab 聚焦，↑ ↓ / ← → 移動並選取，Space 選取。選取時 2px primary 外框與淡藍底，前方圓點填滿。

---

## 3. 浮層

### Dialog

模態對話框：遮罩、置中（或靠上）、開啟時聚焦、Esc 與點遮罩關閉。

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `title` | ReactNode | — | 顯示為 h2，字串時同時是 `aria-label` |
| `label` | string | — | 沒有可見標題時的無障礙名稱 |
| `onClose` | () => void | — | Esc、點遮罩、關閉鈕 |
| `onSubmit` | () => void | — | 有值時整個對話框是 `<form>`，Enter 送出 |
| `width` | `sm` \| `md` \| `lg` | `md` | 480 / 560 / 600 |
| `placement` | `center` \| `top` | `center` | `top`：距頂 12vh、最高 60vh（指令面板） |
| `padded` | boolean | true | false：無內距、內容自行排版（指令面板） |
| `closeButton` | boolean | false | 右上角 × |
| `dirty` | boolean | false | 有未儲存的修改：Esc、點遮罩、× 不直接關閉，改在對話框底部詢問「放棄未儲存的修改？〔放棄〕〔繼續編輯〕」（聚焦「繼續編輯」）。對話框內的「取消」按鈕是明確動作，直接呼叫 `onClose` |

內容由上而下：標題 → 欄位 → `ErrorText` → 動作列（右對齊，`取消` secondary 在左、主動作 primary 在右）。最高 90vh，超過時對話框內捲動。

用在：新增 / 編輯（目標、知識）、閱讀詳情、指令面板。不要用在：需要使用者確認或簽署條文（用 `ConfirmDialog`）、通知使用者（用 `NoticeDialog`）、錨定在按鈕旁的小面板（用 `Popover`）。

### ConfirmDialog（v0.6）

**統一的確認對話框**：所有需要使用者確認才執行的動作（刪除、移除、停用、送出前確認），以及需要使用者閱讀並同意的條文（開啟 AI 代理、使用條款），都用它，不在各頁手寫確認框。

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `title` | string | — | 一句話問題，例如「刪除『設施清冊』？」 |
| `body` | string | — | 說明，**Markdown**（`Markdown` 元件：不轉譯原始 HTML，連結以外部瀏覽器開啟）；長內容在對話框內捲動 |
| `tone` | `primary` \| `danger` | `primary` | `danger`：主按鈕為 danger 樣式，用於不可逆動作 |
| `confirmLabel` | string | 「確認」 | 主按鈕文字，寫出動作（「刪除」「我了解，開啟」） |
| `cancelLabel` | string | 「取消」 | |
| `acknowledge` | string | — | 有值時在說明下方顯示 `Checkbox`（例如「我已閱讀並同意以上內容」），勾選後主按鈕才能按（簽署條文的例外：此時以停用表示「尚未同意」） |
| `onConfirm` | () => void \| Promise | — | 執行中主按鈕 `busy`、不能關閉；失敗時在對話框內顯示 `ErrorText` 並保持開啟；成功後關閉 |
| `onCancel` | () => void | — | 取消、Esc、點遮罩 |

- `role="alertdialog"`，`aria-labelledby` = 標題、`aria-describedby` = 說明。
- 開啟時聚焦：`danger` 聚焦「取消」（避免 Enter 誤刪），`primary` 聚焦主按鈕；有 `acknowledge` 時聚焦勾選框。
- 版面：寬 `sm`；標題 → 說明 → 勾選框 → `ErrorText` → 動作列（取消在左、主按鈕在右）。

### NoticeDialog（v0.6）

**通知對話框**：使用者必須看到、但不需要做決定的訊息，依等級區分。

| 等級 `level` | 顏色 token | 圖示 | 用在 | role |
|---|---|---|---|---|
| `info` | `primary` | ⓘ | 說明、新功能、流程提示 | `dialog` |
| `success` | `st-online` | ✓ | 重要流程完成（加入組織、匯入完成） | `dialog` |
| `warning` | `warning` | ! | 需要注意但不影響使用（金鑰交接中、資料將離開端對端加密） | `alertdialog` |
| `danger` | `danger` | ✕ | 錯誤或失敗、需要處理（無法啟動、同步失敗、申請被拒絕） | `alertdialog` |

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `level` | 上表 | `info` | 圖示圓框與標題左側的等級文字（例如「注意」）一起表示等級，不只用顏色 |
| `title` | string | — | |
| `body` | string | — | Markdown，同 `ConfirmDialog` |
| `actionLabel` | string | 「知道了」 | 唯一的主按鈕，按下即關閉 |
| `secondary` | `{ label, onClick }` | — | 選填的次要動作（例如「查看詳情」） |
| `onClose` | () => void | — | 主按鈕、Esc、點遮罩 |

- 開啟時聚焦主按鈕；寬 `sm`。
- 和 `Toast` 的分工：剛完成的一般動作、可忽略的回饋用 `Toast`（不打斷）；一定要讀到的訊息用 `NoticeDialog`。動作失敗、留在原畫面即可修正的錯誤仍用 `ErrorText`。

### Popover

非模態浮動面板，錨定在觸發元素旁：狀態選單、成員名片、任務選擇、資料夾摘要。

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `label` | string | — | `role="dialog"` 的名稱 |
| `onClose` | () => void | — | Esc、點外面 |
| `closeOnOutside` | boolean | true | false：只有 Esc 或面板內的按鈕能關 |
| `anchorRef` | ref | — | 觸發按鈕：點它不算外面，由按鈕自己切換（避免關了又開） |
| `autoFocus` | boolean | true | 開啟時聚焦面板（面板內有 autoFocus 的元素時設 false） |
| `className` / `style` | — | — | **位置**（`absolute bottom-full left-0 mb-2`）與寬度、內距 |

觸發按鈕設定 `aria-expanded`，父層 `relative`。

### Tooltip（v0.4，D47）

滑過或聚焦觸發元素時顯示的說明卡（方向羅盤的人像摘要）。內容只用於補充；重要資訊在點擊後的畫面也要找得到。

| prop | 型別 | 說明 |
|---|---|---|
| `content` | ReactNode | 卡片內容 |
| `children` | ReactElement | 觸發元素（應可聚焦，例如 `Pressable`） |
| `side` | `'left' \| 'right'` | 卡片往哪一側展開（預設 right） |
| `open` | boolean | 選填：固定顯示（設計稿、測試） |

觸發元素加 `aria-describedby` 指向卡片（`role="tooltip"`）；滑過、聚焦時顯示，離開、失焦或 Esc 時隱藏；卡片本身滑過時保持顯示。

### Menu、MenuItem

動作選單（附加檔案）。開啟時聚焦第一項，↑↓ 移動、Enter 執行、Esc 或點外面關閉。

| 元件 | prop | 說明 |
|---|---|---|
| `Menu` | `label`、`onClose`、`anchorRef`、`className`（位置） | `role="menu"`，最小寬 176 |
| `MenuItem` | `onSelect`、`disabled` | `role="menuitem"` |

觸發按鈕加 `aria-haspopup="menu"` 與 `aria-expanded`。選項是互斥狀態時用 `Select` 或 `SegmentedControl`，不要用 Menu。

---

## 4. 切換

### SegmentedControl

膠囊切換：同一區塊的**檢視**或**類型**（山景 / 清單、星空 / 清單、日報 / 週報）。2–4 個選項，放在頂列動作區。

| prop | 型別 |
|---|---|
| `label` | string（tablist 名稱） |
| `options` | `{ value, label }[]` |
| `value`、`onChange` | 受控 |

鍵盤：只有選取的選項可 Tab 聚焦；← → 切換並聚焦。

### Tabs

底線分頁：同一面板內的不同內容區（設定的個人 / 組織 / 成員、對話抽屜的成員 / 檔案 / 任務）。API 同 SegmentedControl，另有 `fill`（平均佔滿寬度）。鍵盤同上。

選擇：切換「怎麼看同一份資料」用 SegmentedControl；切換「看哪一份內容」用 Tabs。

### Stepper（v0.3，D47）

精靈的步驟指示：`<nav aria-label>` 內依序顯示編號圓點與步驟名稱，步驟之間以短線相連；已完成 = 綠底 ✓、目前 = primary 底且 `aria-current="step"`、未到 = 灰框。只做顯示，不可點（回上一步用頁面的「上一步」）。

| prop | 型別 |
|---|---|
| `label` | string |
| `steps` | string[] |
| `current` | number（0 起算） |

---

## 5. 顯示

### Card

| prop | 型別 | 預設 |
|---|---|---|
| `padding` | `sm` \| `md` \| `none` | `md`（20；sm 16） |

白底、圓角 16、`shadow-sm`，`<section>`。一張卡回答一件事（ui-spec「摘要圖卡」）：`SectionLabel` → 一句結論 → 圖解 → 至多一個動作。

### SectionLabel

卡片或區塊上方的小標（12 / 700 / 字距加寬）。`tone`：`muted`（預設）、`primary`、`warning`、`danger`、`success`；`as`：`p`（預設）、`h2`、`h3`。

### Badge

不可點擊的小標記：計數、類型、角色（「今天的山」「任務」「管理者」）。字級 11。

| prop | 型別 | 說明 |
|---|---|---|
| `tone` | `neutral` \| `primary` \| `solid` \| `alert` | 細框灰字 / 天空霧主色 / 主色實心（未讀數）/ 紅底白字（導覽列待辦數） |
| `label` | string | 數字徽章的無障礙說明（例如「3 則未讀」） |

插畫裡的狀態徽章是 `figures.tsx` 的 `SceneBadge` / `StatusBadge`，不是這個元件。

### Chip

可點擊的膠囊：篩選條件（分類）、關聯項目、訊息上的快速動作（回報、轉成任務、存成知識）。

| prop | 型別 | 說明 |
|---|---|---|
| `selected` | boolean | 有傳時為切換型（`aria-pressed`），選取時天空霧底主色框；不傳時為一般動作 |

### EmptyState

列表沒有資料時的說明（14 / muted），可附**一個**主要動作（`action`）。每個列表都要有（ui-spec「共通規則」）。

v0.7：

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `art` | `generic` \| `goals` \| `tasks` \| `chat` \| `knowledge` \| `team` \| `report` \| `none` | `generic` | 說明上方的插畫（design-system §9「空狀態插畫」）；空間很小的行內空狀態（例如表單內一行）用 `none` |
| `loading` | boolean | false | 資料還沒載入：改顯示 `Skeleton`，不顯示說明與動作，避免先閃「還沒有…」 |
| `skeleton` | `Skeleton` 的 `variant` | `list` | `loading` 時的骨架形狀 |

版面：插畫、說明、動作置中排列（`art="none"` 時靠左，同 v0.6 以前）。

### Skeleton（v0.7）

載入中的骨架（design-system §7「載入骨架」）。

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `variant` | `lines` \| `list` \| `cards` \| `board` | `list` | 文字列 / 清單列（圓形 + 兩行）/ 卡片格 / 看板欄 |
| `count` | number | 3 | 列數、卡片數或欄數 |
| `label` | string | 「載入中」 | `role="status"`、`aria-busy="true"` 的名稱 |

整個骨架是一張 SVG，寬度填滿容器；掃光以 CSS 動畫實作，減少動態時停止。

### ProgressBar

| prop | 型別 | 預設 | 說明 |
|---|---|---|---|
| `value` | number | — | 0–1，超出會被夾住 |
| `label` | string | — | 無障礙名稱 |
| `size` | `sm` \| `md` | `md` | 高 8 / 10 |
| `barClassName` | string | `bg-primary` | 換成語意 token：`bg-st-online`（步驟完成）、`bg-level-*`（目標層級） |

圓形進度（倒數環、目標進度環）屬插畫，在各頁以 SVG 畫，只用 token。

### Kbd

快捷鍵提示（`⌘K`）。

---

### GlassPanel（v0.10，D56）

放在插畫背景上的毛玻璃面板（設定頁）。`<section>`，圓角 22、`--hills-glass` 底、`backdrop-blur` 18、細白框與 `--hills-glass-shadow`；降低透明度時改為 `surface` 實色。

| prop | 型別 | 說明 |
|---|---|---|
| `title` | ReactNode | 標題（h2）；有傳時與 `scope` 排在同一列 |
| `scope` | `device` \| `me` \| `org` | 右上角 `ScopeTag` |
| `padding` | `md` \| `none` | 預設 `md`（22 / 24） |

不要用在一般白底頁面（用 `Card`）。

### GlassScope、GlassLayer（v0.10，D56）

`GlassScope` 包住一段畫面時，其中的 `Card` 改為毛玻璃外觀（設定頁沿用既有卡片，例如小組卡、AI 代理卡）。`GlassLayer` 是模糊底層：放在內容後面的絕對定位兄弟元素，避免 `backdrop-filter` 讓卡片內的對話框（`position: fixed`）錯位。`GlassPanel` 與玻璃 `Card` 都用它。

### GlassNav（v0.10，D56）

毛玻璃膠囊導覽（設定分組）。`nav` + `aria-label`；每個項目是按鈕，選取中的為深色實心並設 `aria-current="page"`；可帶數字徽章（`count` + `countLabel`）或提醒圓點（`dotLabel`，有傳才顯示，`role="img"`）。

### ScopeTag（v0.10，D56）

設定項目的影響範圍小標：`device`「這台電腦」、`me`「只有我」、`org`「全組織」。字級 10 / 700、膠囊、三種色調（muted / primary-soft / level-year 淡底）；文字一律顯示，不只靠顏色。

### SwatchGroup（v0.10，D56）

一組色票單選（`role="radiogroup"`，每個色票 `role="radio"` + `aria-checked` + `aria-label`「〈部位〉 第 n 色」）。← → 移動並選取，選取中的色票有 3 px 深色外框。

| prop | 型別 | 說明 |
|---|---|---|
| `label` | string | 部位名稱（顯示在左側，也是 radiogroup 名稱） |
| `colors` | string[] | CSS 顏色（`var(--hills-*)`） |
| `value` / `onChange` | number | 選取的索引 |

### Character、CharacterStage（v0.10，D56）

`Character`（`characters.tsx`，插畫元件，不在 `ui/`）：七種角色的 SVG。props `kind`、`look`、`pose`（`stand` \| `walk` \| `wave` \| `sit`）、`animate`（原地踏步）。在 `<svg>` 內以 `<g>` 繪製，原點在兩腳中間，高度 64 單位。

`CharacterStage`（`ui/`）：設定頁的角色切換舞台。

| prop | 型別 | 說明 |
|---|---|---|
| `count` / `index` / `onChange` | number | 角色數、目前索引、切換（傳入新索引） |
| `label` | string | 目前角色的無障礙名稱（`aria-live="polite"`） |
| `prevLabel` / `nextLabel` | string | 箭頭按鈕名稱 |
| `children` | ReactNode | 目前要顯示的角色 |

切換動畫：舊內容往切換方向反側位移 28 px 並淡出（240 ms），切換後從另一側淡入；動畫中再按箭頭會忽略。舞台可聚焦，← → 切換。下方圓點不可點（`aria-hidden`），位置由 `aria-label` 表達。

## 6. 回饋與流程

| 元件 | 用途 | 重點 |
|---|---|---|
| `ErrorText` | 動作失敗的訊息 | `role="alert"`、紅框；`message` 為 null 時不顯示 |
| `ConfirmButton` | 不可逆動作的按鈕入口 | 顯示 danger 按鈕，點擊後開啟 `ConfirmDialog`（`tone="danger"`，`message` 為說明 Markdown，選填 `title`、`confirmLabel`）；`size` 預設 sm（v0.6：原地展開改為統一的對話框） |
| `Markdown`（v0.6；v0.8 D55） | 顯示 Markdown 內容（全 app 唯一入口） | `react-markdown` + remark-gfm、`prose-hills` 樣式；不轉譯原始 HTML；連結以外部瀏覽器開啟；`variant`：`doc`（預設，標題層級、目錄 `toc` 選填）/ `chat`（精簡、無目錄）；提示框 `> [!NOTE]` / `[!TIP]` / `[!WARNING]`；`## 標題 {#key}` 移除 key 並作為錨點；程式碼區塊顯示語言與「複製」；圖片只顯示 `data:`，其他改為連結 |
| `MarkdownEditor`（v0.8，D55） | 輸入 Markdown | 工具列（粗體、斜體、標題、清單、勾選、連結、程式碼、表格、提示框）、模式 `SegmentedControl`（編輯 / 預覽；v0.9 取消並排）；切換時預覽與編輯區同寬，回到編輯時保留游標，⌘⇧P 切換、⌘B / ⌘I / ⌘K；`value`、`onChange`、`rows`、`aria-label`；預覽用 `Markdown` |
| `HtmlView`（v0.8，D52） | 顯示知識 / 報告的 HTML | 先清理（`sanitizeHtml`），在 `sandbox="allow-same-origin"` 的 iframe 以 `srcdoc` 顯示，注入閱讀樣式，依內容調整高度，攔截連結以外部瀏覽器開啟；下方固定說明「安全顯示」 |
| `DocView`（v0.8，D52） | 依格式顯示文件 | `format` 為 markdown → `Markdown`，html → `HtmlView`；`source` 為 true 時顯示原始碼（等寬、可複製） |
| `useAction` | 執行非同步動作並追蹤 `busy` / `error` | `run(f)` 回傳結果；`attempt(f)` 成功回傳 true |
| `Centered` | 初次啟動流程的置中單欄頁 | 標題 24 / 600 |
| `CodeBox` | 文字碼 + QR + 複製 | QR 一律白底 |
| `Toast`（v0.3，D47） | 剛完成的動作的短暫通知，可附「復原」 | 畫面底部置中深色膠囊，`role="status"`；`message`、`action?: { label, onClick }`、`onClose`；預設 10 秒後自動關閉，滑過或聚焦時暫停計時；Esc 關閉；同時只顯示一則（新的取代舊的） |

---

## 7. 畫面組成模式

| 模式 | 組成 |
|---|---|
| **頁首** | `PageHead`（`layout.tsx`）：標題、副標、頁面動作（SegmentedControl、期間切換 IconButton + Button、主按鈕）都放在頂列，主按鈕在最右。 |
| **主從版面** | 左 / 中為清單（`ListButton` 或 `Pressable` 卡片），右欄 `Card` 顯示選取項目詳情；右欄寬依 ui-spec「版面」。 |
| **表單對話框** | `Dialog onSubmit dirty` + 多個 `Field` + `ErrorText` + 動作列（取消、儲存）。必填欄位用 `Field required` 標示；**不以停用儲存鍵表示驗證失敗**——按下儲存時在欄位顯示錯誤（`Field error`）並聚焦第一個錯誤欄位；儲存鍵只在執行中停用（`busy`）。欄位順序依相依關係：先放會決定其他欄位的選項（例如目標的層級與期間）。 |
| **行內表單** | 卡片或清單內直接編輯：`TextInput size="sm"` + `Button size="sm"`。 |
| **錨定面板** | 觸發按鈕（`aria-expanded`）+ `Popover anchorRef`，或 `Menu`。 |
| **空與錯** | 每個列表 `EmptyState`；每個動作 `useAction` + `ErrorText`。 |
| **確認** | 需要使用者確認的動作一律用 `ConfirmDialog`（不可逆的用 `ConfirmButton` 開啟，`tone="danger"`）；需要閱讀並同意的條文用 `ConfirmDialog acknowledge`；AI 代理送來的修改用「AI 代理確認卡」，AI 產生的動作用「建議動作卡」（M3）。 |
| **通知** | 一定要讀到的訊息用 `NoticeDialog`（依等級 info / success / warning / danger）；一般回饋用 `Toast`；可在原畫面修正的錯誤用 `ErrorText`。 |

## 8. 新增或修改元件

1. 確認現有元件或變體無法表達（能用 `className` 調版面就不新增）。
2. 在本文件加上用途、何時用 / 不用、變體、狀態、鍵盤與無障礙、API。
3. 在 `src/ui/` 實作，只用 design-system token；在 `src/ui/ui.test.tsx` 補 aria 測試。
4. 把畫面中對應的手寫寫法換成新元件。
