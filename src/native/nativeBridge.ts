import { registerPlugin, Capacitor } from '@capacitor/core';

interface MarketScopeNativePlugin {
  startService(options: { text: string }): Promise<void>;
  updateService(options: { text: string }): Promise<void>;
  stopService(): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  getBatteryStatus(): Promise<{ unrestricted: boolean }>;
  openBatterySettings(): Promise<void>;
  getStatus(): Promise<{ serviceRunning: boolean; sdk: number }>;
}

const Native = registerPlugin<MarketScopeNativePlugin>('MarketScopeNative');

export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

export const nativeBridge = {
  startService: (text: string) => Native.startService({ text }),
  updateService: (text: string) => Native.updateService({ text }),
  stopService: () => Native.stopService(),
  requestNotificationPermission: async (): Promise<boolean> => (await Native.requestNotificationPermission()).granted,
  getBatteryStatus: async (): Promise<boolean> => (await Native.getBatteryStatus()).unrestricted,
  openBatterySettings: () => Native.openBatterySettings(),
  getStatus: () => Native.getStatus(),
};
