// Unit tests for fonts resolution, defaults, system fonts, and CSS variable mapping (src/fonts.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFonts, DEFAULT_FONTS, PROSE_FONTS, CODE_FONTS,
  fontById, isSystemFontId, systemFontEntry, fontStack, applyFonts
} from '../src/fonts.js';

test('DEFAULT_FONTS uses system fonts as primary defaults', () => {
  assert.equal(DEFAULT_FONTS.ui, 'system-sans');
  assert.equal(DEFAULT_FONTS.display, 'system-sans');
  assert.equal(DEFAULT_FONTS.markdown, 'system-sans');
  assert.equal(DEFAULT_FONTS.heading, 'system-sans');
  assert.equal(DEFAULT_FONTS.code, 'system-mono');
});

test('PROSE_FONTS and CODE_FONTS list system fonts first', () => {
  assert.equal(PROSE_FONTS[0].id, 'system-sans');
  assert.equal(CODE_FONTS[0].id, 'system-mono');
});

test('isSystemFontId and systemFontEntry identify and format system fonts', () => {
  assert.ok(isSystemFontId('system:Arial'));
  assert.ok(isSystemFontId('system:Fira Sans'));
  assert.ok(!isSystemFontId('inter'));
  assert.ok(!isSystemFontId('system:'));
  assert.ok(!isSystemFontId(null));

  const entry = systemFontEntry('system:Comic Sans MS', false);
  assert.equal(entry.id, 'system:Comic Sans MS');
  assert.equal(entry.label, 'Comic Sans MS');
  assert.ok(entry.stack.includes("'Comic Sans MS'"));
});

test('resolveFonts merges stored settings and handles display & heading', () => {
  const resolvedDefault = resolveFonts(undefined);
  assert.equal(resolvedDefault.ui, 'system-sans');
  assert.equal(resolvedDefault.display, 'system-sans');
  assert.equal(resolvedDefault.markdown, 'system-sans');
  assert.equal(resolvedDefault.heading, 'system-sans');
  assert.equal(resolvedDefault.code, 'system-mono');

  const custom = resolveFonts({
    ui: 'inter',
    display: 'system:Fira Sans',
    markdown: 'lora',
    heading: 'system:Ubuntu',
    code: 'fira-code'
  });
  assert.equal(custom.ui, 'inter');
  assert.equal(custom.display, 'system:Fira Sans');
  assert.equal(custom.markdown, 'lora');
  assert.equal(custom.heading, 'system:Ubuntu');
  assert.equal(custom.code, 'fira-code');
});

test('fontStack returns valid CSS font-family strings', () => {
  assert.ok(fontStack('system-sans', 'system-sans').includes('system-ui'));
  assert.ok(fontStack('system:Arial', 'system-sans').includes("'Arial'"));
  assert.ok(fontStack('inter', 'system-sans').includes("'Inter'"));
});

test('applyFonts sets all CSS custom properties on document element', () => {
  // Mock global document if running under Node.js
  const properties = {};
  const mockStyle = {
    setProperty(key, val) {
      properties[key] = val;
    }
  };
  globalThis.document = {
    documentElement: { style: mockStyle }
  };

  const fonts = resolveFonts({
    ui: 'system-sans',
    display: 'system:Impact',
    markdown: 'system-sans',
    heading: 'system:Georgia',
    code: 'system-mono'
  });

  applyFonts(fonts);

  assert.ok(properties['--font-sans']);
  assert.ok(properties['--font-display'].includes("'Impact'"));
  assert.ok(properties['--font-doc']);
  assert.ok(properties['--font-heading'].includes("'Georgia'"));
  assert.ok(properties['--font-mono']);
});
