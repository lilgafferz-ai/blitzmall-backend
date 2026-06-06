import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.blitzmall.shop',
  appName: 'BlitzMall',
  webDir: 'build',
  server: {
    url: 'https://blitzmall-frontend.vercel.app',
    cleartext: false,
    androidScheme: 'https'
  },
  android: {
    backgroundColor: '#0a0a0c'
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
      launchAutoHide: false,
      backgroundColor: '#0a0a0c',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false
    }
  }
};
export default config;