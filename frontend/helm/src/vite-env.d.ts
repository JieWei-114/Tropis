/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GRPC_WEB_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
