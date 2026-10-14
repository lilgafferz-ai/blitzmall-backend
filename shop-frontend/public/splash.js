// Removes the pre-splash once React renders. Kept out of index.html so the
// Content-Security-Policy can forbid inline scripts.
(function () {
  const observer = new MutationObserver(() => {
    if (document.getElementById('root') && document.getElementById('root').children.length > 0) {
      const ps = document.getElementById('pre-splash');
      if (ps) { ps.style.opacity = '0'; setTimeout(() => ps.remove(), 500); }
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('root'), { childList: true });
})();
