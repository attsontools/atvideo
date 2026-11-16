import type {
  ActivationResult,
  ThemeName,
  VideoHost,
  VideoServiceMethod
} from './host';
import { buildDownloadActivation } from './downloadActivation';

const APP_ID = 'com.attson.video';
const ARIA2_APP_ID = 'com.attson.aria2';
const REQUIRED_CAPABILITIES = [
  'host.theme.read',
  'host.video.extract',
  'host.clipboard.write',
  'host.external.open',
  'host.app.activate'
] as const;

interface PluginHandshake {
  theme: ThemeName;
  capabilities: string[];
}

interface PluginConnection {
  handshake(): Promise<PluginHandshake>;
  call(method: string, params?: unknown): Promise<unknown>;
  onThemeChange(listener: (theme: ThemeName) => void): () => void;
  close(): void;
}

type ConnectPlugin = (appId: string) => Promise<PluginConnection>;

export function createPluginHost(connect: ConnectPlugin): VideoHost {
  let connection: PluginConnection | null = null;
  let removeThemeListener: (() => void) | null = null;

  function requireConnection(): PluginConnection {
    if (!connection) throw new Error('VIDEO_SERVICE_NOT_CONNECTED');
    return connection;
  }

  return {
    mode: 'plugin',
    canSendToAria2: true,
    async initialize(onTheme) {
      removeThemeListener?.();
      connection?.close();
      removeThemeListener = null;
      connection = await connect(APP_ID);
      const handshake = await connection.handshake();
      const missing = REQUIRED_CAPABILITIES.find(
        (capability) => !handshake.capabilities.includes(capability)
      );
      if (missing) {
        connection.close();
        connection = null;
        throw new Error(`HOST_PERMISSION_DENIED: ${missing}`);
      }
      removeThemeListener = connection.onThemeChange(onTheme);
      onTheme(handshake.theme);
      return handshake.theme;
    },
    async request<T>(method: VideoServiceMethod, params: Record<string, unknown>): Promise<T> {
      return await requireConnection().call('host.video.extract', { method, params }) as T;
    },
    async copyText(text) {
      const result = asRecord(await requireConnection().call('host.clipboard.writeText', { text }));
      if (result.copied !== true) throw invalidResponse();
    },
    async openExternal(url) {
      const result = asRecord(await requireConnection().call('host.external.open', { url }));
      if (result.opened !== true) throw invalidResponse();
    },
    async sendToAria2(urls): Promise<ActivationResult> {
      const payload = buildDownloadActivation(urls);
      const result = asRecord(await requireConnection().call('host.app.activate', {
        appId: ARIA2_APP_ID,
        payload
      }));
      if (result.accepted !== true || typeof result.activationId !== 'string') {
        throw invalidResponse();
      }
      return { activationId: result.activationId };
    },
    dispose() {
      removeThemeListener?.();
      removeThemeListener = null;
      connection?.close();
      connection = null;
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function invalidResponse(): Error {
  return new Error('VIDEO_HOST_RESPONSE_INVALID');
}
