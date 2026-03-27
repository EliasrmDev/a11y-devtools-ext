chrome.devtools.panels.create(
  'a11y',           // panel title
  null,             // icon (no icon path needed)
  'devtools/panel.html',
  (panel) => {
    // Panel created — nothing extra needed here
  }
);
