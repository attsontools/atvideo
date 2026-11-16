import { connectPlugin, NATIVE_SERVICE_HOST_API_VERSION } from '@attson/plugin-sdk/browser';

import { createPluginHost } from './pluginHost';

export const host = createPluginHost((appId) => connectPlugin(appId, {
  apiVersion: NATIVE_SERVICE_HOST_API_VERSION,
  timeoutMs: 120_000
}));
