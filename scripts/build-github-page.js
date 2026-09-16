#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCspOrigins, buildBackgroundStyle, injectTitle, injectApiBase } from '../src/utils/csp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

// Load .env file
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const apiBase = parseCspOrigins(process.env.API_BASE || '');
const title = process.env.TITLE || '';
const backgroundImage = process.env.BACKGROUND_IMAGE || '';

console.log('Config from env:', { apiBase, title, backgroundImage });

console.log('Cleaning dist directory...');
if (fs.existsSync(distDir)) {
  fs.removeSync(distDir);
}

console.log('Building theme frontend...');
execSync('npx vite build', { cwd: rootDir, stdio: 'inherit', env: { ...process.env, VITE_BASE: './' } });

// 构建时注入配置到 HTML
const htmlFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.html'));
for (const file of htmlFiles) {
  const filePath = path.join(distDir, file);
  let html = fs.readFileSync(filePath, 'utf8');

  // 1. 注入 title
  html = injectTitle(html, title)

  // 2. 注入运行时 meta 标签
  html = injectApiBase(html, apiBase)

  // 3. 注入背景图样式
  if (backgroundImage) {
    const bgStyle = buildBackgroundStyle(backgroundImage)
    html = html.replace('</head>', `${bgStyle}\n</head>`);
  }

  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`Injected config into ${file}`);
}

console.log('Build complete!');
