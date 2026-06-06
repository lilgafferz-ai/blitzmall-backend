import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('BlitzMall render crash:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', padding: 24, background: '#0a0a0c', color: '#fff' }}>
          <h1>BlitzMall hit a render error</h1>
          <p>The app crashed while loading this screen. Check the console for the exact error.</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff7a1a' }}>
            {String(this.state.error?.message || this.state.error || 'Unknown error')}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}