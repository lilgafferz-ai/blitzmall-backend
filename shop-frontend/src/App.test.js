import { render } from '@testing-library/react';
import App from './App';

// Smoke test: the app should mount without throwing.
// (The old default test looked for a "learn react" link that doesn't exist
// in BlitzMall, so it always failed. This verifies the app actually renders.)
test('App renders without crashing', () => {
  const { container } = render(<App />);
  expect(container).toBeTruthy();
});
