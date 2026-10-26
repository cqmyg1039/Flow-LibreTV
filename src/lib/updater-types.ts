export type UpdaterStatus =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdaterState {
  revision: number;
  currentVersion: string;
  supported: boolean;
  status: UpdaterStatus;
  manual: boolean;
  version?: string;
  notes?: string;
  percent?: number;
  bytesPerSecond?: number;
  message?: string;
}

export interface UpdaterApi {
  getState: () => Promise<UpdaterState>;
  check: () => Promise<{ ok: boolean }>;
  download: () => Promise<{ ok: boolean }>;
  install: () => Promise<{ ok: boolean }>;
  onState: (callback: (state: UpdaterState) => void) => () => void;
}

declare global {
  interface Window {
    libreUpdater?: UpdaterApi;
  }
}
