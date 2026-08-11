// Device presets for the rail browser's responsive viewer. Mirrors Chrome
// DevTools' device toolbar — width/height are CSS pixels (the screen size
// Electron's enableDeviceEmulation paints into), dpr is the device-pixel
// ratio, mobile flips touch + mobile UA flags, ua is the User-Agent we spoof.

export type DeviceKind = 'mobile' | 'tablet' | 'desktop';

export interface BrowserDevicePreset {
  id: string;
  label: string;
  kind: DeviceKind;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  ua: string;
}

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_GALAXY =
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_SURFACE_DUO =
  'Mozilla/5.0 (Linux; Android 13; SM-D818U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const UA_SURFACE_PRO =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const BROWSER_DEVICE_PRESETS: BrowserDevicePreset[] = [
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    kind: 'mobile',
    width: 375,
    height: 667,
    dpr: 2,
    mobile: true,
    ua: UA_IPHONE
  },
  {
    id: 'iphone-14-pro',
    label: 'iPhone 14 Pro',
    kind: 'mobile',
    width: 393,
    height: 852,
    dpr: 3,
    mobile: true,
    ua: UA_IPHONE
  },
  {
    id: 'iphone-14-pro-max',
    label: 'iPhone 14 Pro Max',
    kind: 'mobile',
    width: 430,
    height: 932,
    dpr: 3,
    mobile: true,
    ua: UA_IPHONE
  },
  {
    id: 'pixel-8',
    label: 'Pixel 8',
    kind: 'mobile',
    width: 412,
    height: 915,
    dpr: 2.625,
    mobile: true,
    ua: UA_ANDROID_PHONE
  },
  {
    id: 'galaxy-s24',
    label: 'Galaxy S24 Ultra',
    kind: 'mobile',
    width: 412,
    height: 883,
    dpr: 3.5,
    mobile: true,
    ua: UA_GALAXY
  },
  {
    id: 'surface-duo',
    label: 'Surface Duo',
    kind: 'tablet',
    width: 540,
    height: 720,
    dpr: 2.5,
    mobile: true,
    ua: UA_SURFACE_DUO
  },
  {
    id: 'ipad-mini',
    label: 'iPad Mini',
    kind: 'tablet',
    width: 768,
    height: 1024,
    dpr: 2,
    mobile: true,
    ua: UA_IPAD
  },
  {
    id: 'ipad-air',
    label: 'iPad Air',
    kind: 'tablet',
    width: 820,
    height: 1180,
    dpr: 2,
    mobile: true,
    ua: UA_IPAD
  },
  {
    id: 'ipad-pro',
    label: 'iPad Pro 12.9"',
    kind: 'tablet',
    width: 1024,
    height: 1366,
    dpr: 2,
    mobile: true,
    ua: UA_IPAD
  },
  {
    id: 'surface-pro-7',
    label: 'Surface Pro 7',
    kind: 'desktop',
    width: 912,
    height: 1368,
    dpr: 1.5,
    mobile: false,
    ua: UA_SURFACE_PRO
  }
];

export function findPreset(id: string | undefined): BrowserDevicePreset | undefined {
  if (!id) return undefined;
  return BROWSER_DEVICE_PRESETS.find((p) => p.id === id);
}
