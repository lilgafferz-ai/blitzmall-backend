/*
 * Strict production build — treats ESLint warnings as errors, exactly like
 * GitHub Actions does (its runners set CI=true, and react-scripts build then
 * fails on any lint warning).
 *
 * Run this BEFORE pushing so an unused variable or other lint warning can never
 * silently break the release pipeline again (the v0.1.26 release was blocked
 * for exactly this reason — an unused `bestRedeemValue` only failed under CI).
 *
 *   npm run build:strict
 *
 * Exit code is non-zero when the build fails, so it works as a pre-push check
 * or a CI guard. No new dependencies — it just re-invokes react-scripts' own
 * build script with the CI env var that makes warnings fatal.
 */
process.env.CI = 'true';

try {
  require('react-scripts/scripts/build');
} catch (e) {
  console.error('[build:strict] Build failed with warnings-as-errors enabled:', e && e.message);
  process.exit(1);
}
