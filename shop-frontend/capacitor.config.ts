import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.blitzmall.shop',
  appName: 'BlitzMall',
  webDir: 'build',
  server: {
    url: 'https://blitzmall-backend.onrender.com',
    cleartext: true
  },
  android: {
    backgroundColor: '#0a0a0c'
  },
  plugins: {
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