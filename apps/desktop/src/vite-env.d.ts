/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 建立組織時預先填入的 mailbox 連線碼（建置設定，不提交到 repo，D20） */
  readonly VITE_HILLS_DEFAULT_MAILBOX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
