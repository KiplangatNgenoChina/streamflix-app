#!/usr/bin/env node
/** Copy web assets to www/ for Capacitor. When using remote URL, this is fallback/placeholder. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const FILES = ['index.html', 'styles.css', 'script.js'];

if (!fs.existsSync(WWW)) fs.mkdirSync(WWW, { recursive: true });

FILES.forEach((file) => {
  const src = path.join(ROOT, file);
  const dest = path.join(WWW, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file}`);
  }
});
