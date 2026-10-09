'use strict';
/* The renderer's settings whitelist in electron/rendererSettings.cjs. Run: node --test test/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRendererSetting, isRendererSettingKey } = require('../electron/rendererSettings.cjs');

const show = (value) => {
  try {
    return JSON.stringify(value)?.slice(0, 80);
  } catch {
    return '(unserialisable)';
  }
};
const ok = (key, value) => assert.deepEqual(checkRendererSetting(key, value), { ok: true }, `${key} = ${show(value)}`);
const refused = (key, value) => assert.equal(checkRendererSetting(key, value).ok, false, `${key} = ${show(value)}`);

test('every setting the renderer writes today is accepted', () => {
  ok('theme', 'fate');
  ok('theme', 'custom');
  ok('autoUpdatesEnabled', false);
  ok('sidebarWidth', 300);
  ok('shortcuts', { openFile: 'Control+O', toggleSplit: 'Control+\\' });
  ok('printPageSize', 'A4');
  ok('printLandscape', true);
  ok('editorWrap', true);
  ok('editorTabSize', 4);
  ok('editorLint', false);
  ok('fonts', { ui: 'system-sans', display: 'system:Arial', markdown: 'system-sans', heading: 'system:Georgia', code: 'system-mono', markdownSize: 16, editorSize: 14, ligatures: true, perType: { ps1: 'cascadia-code' } });
  ok('restoreSession', true);
  ok('customTheme', { base: '#070B1A', accent: '#D4AF37' });
  ok('customTheme', null);
  ok('session', { paths: ['/home/me/a.md', 'C:\\Users\\me\\b.ps1'], active: '/home/me/a.md' });
  ok('session', { paths: [], active: null });
  ok('spellcheck', true);
  ok('remoteImages', false);
});

test('main-only keys and unknown keys are refused', () => {
  for (const key of ['recentFiles', 'registrationStamp', 'claimedTypes', 'recentFiles.0.path', 'theme.x', '__proto__', 'constructor', 'toString', '', null, 7]) {
    assert.equal(isRendererSettingKey(key), false, String(key));
    refused(key, 'x');
  }
});

test('wrong types are refused', () => {
  refused('theme', 3);
  refused('theme', 'x'.repeat(65));
  refused('autoUpdatesEnabled', 'yes');
  refused('sidebarWidth', NaN);
  refused('sidebarWidth', -5);
  refused('sidebarWidth', '300');
  refused('shortcuts', ['Control+O']);
  refused('shortcuts', { openFile: 5 });
  refused('editorTabSize', 0);
  refused('fonts', 'inter');
  refused('customTheme', '#fff');
  refused('session', { paths: '/etc/passwd' });
  refused('session', { paths: [1, 2] });
  refused('session', { paths: [], active: 5 });
  refused('spellcheck', 1);
  refused('remoteImages', undefined);
});

test('values too large or unserialisable are refused', () => {
  refused('session', { paths: Array.from({ length: 5000 }, (_, i) => `/very/long/path/number/${i}/`.repeat(3)) });
  const cyclic = { ui: 'inter' };
  cyclic.self = cyclic;
  refused('fonts', cyclic);
});
