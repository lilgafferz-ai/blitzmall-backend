import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.blitzmall.shop',
  appName: 'BlitzMall',
  webDir: 'build',
  // No `server.url`: the web assets are bundled INSIDE the app, so it is a real
  // standalone app that opens offline and is fit for the Play Store. Live data
  // still comes from the online backend (API_URL), and new web versions are
  // delivered over-the-air by the self-hosted Capgo updater (see src/index.js).
  android: {
    backgroundColor: '#0a0a0c'
  },
  plugins: {
    CapacitorUpdater: {
      // Manual / self-hosted mode — we control downloads ourselves against our
      // own Render server instead of the Capgo cloud.
      autoUpdate: false,
      resetWhenUpdate: true
    },
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: '#0a0a0c',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false
    }
  }
};
export default config;
