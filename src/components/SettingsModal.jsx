import { useState, useEffect, useRef, useMemo, useId } from 'react';
import {
  X, Palette, TextAa, Code, Printer, WindowsLogo, Keyboard, Info,
  CaretDown, Check, Trash, ArrowSquareOut, CheckCircle, Plus, Copy, ArrowCounterClockwise,
  Warning, MarkdownLogo
} from '@phosphor-icons/react';
import fateLogo from '../assets/FATE-Square-Icon.png';
import {
  THEMES, PAGE_SIZES, SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, FIXED_SHORTCUTS,
  shortcutParts, formatShortcutLabel, normalizeBinding,
  clampSidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX
} from '../settingsMeta.js';
import { PROSE_FONTS, CODE_FONTS, fontById, systemFontEntry } from '../fonts.js';
import { CODE_EXTENSIONS } from '../fileKinds.js';
import { DEFAULT_CUSTOM, CUSTOM_FIELDS, customThemeCss } from '../themeCustom.js';
import { useDialogFocus } from '../dialogFocus.js';

/**
 * SettingsModal: navigation rail + content pane (1.10.0 redesign, extended in 1.11.0 with the
 * full keybinding editor, the custom theme builder, and the association tools).
 *
 * Design notes:
 *   - Theme cards render INSIDE their own theme via data-theme scoping; previews come from the
 *     theme's real tokens, never hand-kept swatches. The custom theme's card works the same way
 *     because its block is injected as real CSS (see src/themeCustom.js).
 *   - FontPicker is a custom listbox because a native <select> cannot render each option in its
 *     own typeface.
 *   - Everything stays token-driven; no colour literal in this file or its CSS.
 *
 * 1.14.0:
 *   - A real modal (dialogFocus.js): focus moves in on open, Tab stays inside, focus goes back to
 *     the editor on close, and Escape closes Settings itself. It used to fall through to App,
 *     which closed a diff open behind Settings first.
 *   - Every switch, select, slider and field is named by its setting's label (aria-labelledby),
 *     so a screen reader says "Wrap long lines, switch, off" rather than "checkbox".
 *   - `initialSection` opens on a given page (the palette's Keyboard shortcuts command passes
 *     'shortcuts', the About menu item 'about').
 *   - Shortcut keycaps and hints render the live binding (shortcutParts), never a hard-coded key;
 *     "New files (Ctrl+N)" was wrong from the day the default became Ctrl+T.
 *   - The shortcut recorder stops when Settings closes, and Escape cancels it instead of
 *     becoming the new binding.
 */

const PROSE_SAMPLE = 'The quick brown fox jumps over the lazy dog.';
const CODE_SAMPLE = 'const sum = (a, b) => a !== b ? a + b : 0;';

/** How many filtered system fonts to render at once; each row rasterises its own typeface. */
const SYSTEM_FONT_LIMIT = 30;

/**
 * `labelledBy` is the id of the setting's label: the button reads as "Code font, Fira Code" (the
 * label, then the current font) instead of just the font's name.
 */
function FontPicker({ value, options, onChange, mono, systemFonts = [], labelledBy }) {
  const currentId = useId();
  const [open, setOpen] = useState(false);
  /* Opens UPWARD when the button sits low in the viewport. The list is absolutely positioned
     inside the modal's scroll pane, so opening down near the bottom clipped it (user-reported). */
  const [openUp, setOpenUp] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const filterRef = useRef(null);

  const toggleOpen = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setOpenUp(window.innerHeight - rect.bottom < 320);
      setQuery('');
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    filterRef.current?.focus();
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    // Capture-phase Escape closes ONLY the picker; the app-level handler skips defaultPrevented.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const current = fontById(value, mono) || options[0];

  const q = query.trim().toLowerCase();
  const bundled = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const systemMatches = q ? systemFonts.filter((n) => n.toLowerCase().includes(q)) : systemFonts;
  const systemShown = systemMatches.slice(0, SYSTEM_FONT_LIMIT);

  const trimmedQuery = query.trim();
  const hasExactMatch = q
    ? options.some((o) => o.label.toLowerCase() === q) || systemFonts.some((n) => n.toLowerCase() === q)
    : true;
  const customOption =
    trimmedQuery && !hasExactMatch
      ? systemFontEntry(`system:${trimmedQuery}`, mono)
      : null;

  const pick = (id) => {
    onChange(id);
    setOpen(false);
  };

  const renderOption = (o, customLabel) => (
    <li
      key={o.id}
      role="option"
      aria-selected={o.id === value}
      className={`fp-option ${o.id === value ? 'selected' : ''}`}
      onClick={() => pick(o.id)}
    >
      <span className="fp-texts">
        <span className="fp-name" style={{ fontFamily: o.stack }}>
          {customLabel || o.label}
          {o.ligatures && <span className="fp-tag">ligatures</span>}
        </span>
        <span className="fp-sample" style={{ fontFamily: o.stack }}>
          {mono ? CODE_SAMPLE : PROSE_SAMPLE}
        </span>
      </span>
      {o.id === value && <Check size={14} weight="bold" className="fp-check" />}
    </li>
  );

  return (
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        className="font-picker-btn"
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelledBy ? `${labelledBy} ${currentId}` : undefined}
        style={{ fontFamily: current.stack }}
      >
        <span className="fp-current" id={currentId}>{current.label}</span>
        <CaretDown size={13} weight="bold" className={`fp-caret ${open ? 'up' : ''}`} />
      </button>

      {open && (
        <div className={`font-picker-list ${openUp ? 'up' : ''}`}>
          <input
            ref={filterRef}
            className="fp-filter"
            placeholder={
              systemFonts.length > 0
                ? `Search ${systemFonts.length + options.length} fonts or type name…`
                : 'Search or type font name…'
            }
            aria-label="Search fonts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const first =
                  customOption ??
                  bundled[0] ??
                  (systemShown[0] && systemFontEntry(`system:${systemShown[0]}`, mono));
                if (first) pick(first.id);
              }
            }}
            spellCheck={false}
          />

          <ul role="listbox" aria-labelledby={labelledBy}>
            {customOption && (
              <>
                <li className="fp-section">Custom system font</li>
                {renderOption(customOption, `Use system font "${trimmedQuery}"`)}
              </>
            )}

            {bundled.length > 0 && <li className="fp-section">Bundled with FATE</li>}
            {bundled.map((o) => renderOption(o))}

            {systemFonts.length > 0 && systemShown.length > 0 && (
              <li className="fp-section">Installed on this PC</li>
            )}
            {systemShown.map((name) => renderOption(systemFontEntry(`system:${name}`, mono)))}
            {systemMatches.length > SYSTEM_FONT_LIMIT && (
              <li className="fp-more">
                {systemMatches.length - SYSTEM_FONT_LIMIT} more. Keep typing to narrow the list.
              </li>
            )}
            {!customOption && bundled.length === 0 && systemShown.length === 0 && (
              <li className="fp-more">No fonts match &quot;{query}&quot;</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function SizeSlider({ label, value, min, max, suffix = 'px', onChange }) {
  const labelId = useId();
  return (
    <div className="setting-item">
      <span className="setting-label" id={labelId}>{label}</span>
      <span className="size-slider">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-labelledby={labelId}
          aria-valuetext={`${value}${suffix}`}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
        />
        <span className="size-readout">{value}{suffix}</span>
      </span>
    </div>
  );
}

/**
 * The toggle switch, named by its setting's label (`labelledBy`, an element id) and optionally
 * described by its hint. role="switch" so it is announced as on/off rather than as a checkbox.
 */
function Switch({ checked, onChange, labelledBy, describedBy, disabled }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="slider" aria-hidden="true"></span>
    </label>
  );
}

/**
 * Pretty-print a stored binding ("Control+Shift+S" → chips). Through shortcutParts, which knows
 * the stored format: splitting on "+" here broke on a binding of the + key itself.
 */
function BindingChips({ binding }) {
  return (
    <span className="kbd-group">
      {shortcutParts(binding).map((p, i) => <kbd key={i}>{p}</kbd>)}
    </span>
  );
}

/** A live binding inside running text: <code>Ctrl</code>+<code>T</code>. */
function InlineBinding({ binding }) {
  return shortcutParts(binding).map((p, i) => (
    <span key={i}>{i > 0 && '+'}<code>{p}</code></span>
  ));
}

/**
 * Default sidebar width. Up to 1.13 every keystroke saved straight to the store with no bounds,
 * so typing "450" saved 4, then 45, then 450, and the contents sidebar of every open document
 * jumped to 4 px wide on the way. Now the field keeps a draft while you type and commits on blur
 * or Enter, clamped to 200–600; Escape puts the saved value back. Input that isn't a number
 * (an empty field, a lone "-") is ignored.
 */
function SidebarWidthField({ value, onCommit, labelledBy, describedBy }) {
  const [draft, setDraft] = useState(null);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) return;
    const width = clampSidebarWidth(n);
    if (width !== value) onCommit(width);
  };

  return (
    <input
      type="number"
      min={SIDEBAR_WIDTH_MIN}
      max={SIDEBAR_WIDTH_MAX}
      step={10}
      value={draft ?? value}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape' && draft !== null) {
          // First Escape reverts the edit; the next one closes Settings.
          e.preventDefault();
          setDraft(null);
        }
      }}
    />
  );
}

function SettingsModal({
  onClose,
  settings,
  updateSetting,
  appVersion,
  defaultAppStatus,
  requestDefaultApp,
  activeShortcutRebind,
  setActiveShortcutRebind,
  onSidebarWidthChange,
  runtimeInfo,
  systemFonts,
  initialSection = 'appearance'
}) {
  const [section, setSection] = useState(initialSection || 'appearance');
  /*
   * A new initialSection while open (About chosen from the menu with Settings already up) moves
   * to that page. Render-time adjustment rather than an effect, like CommandPalette's query.
   */
  const [lastInitialSection, setLastInitialSection] = useState(initialSection);
  if (lastInitialSection !== initialSection) {
    setLastInitialSection(initialSection);
    if (initialSection) setSection(initialSection);
  }
  const [coverage, setCoverage] = useState(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairResult, setRepairResult] = useState(null);
  const [classicMenu, setClassicMenu] = useState(null);
  const [explorerRestartNeeded, setExplorerRestartNeeded] = useState(false);
  const [newOverrideExt, setNewOverrideExt] = useState('');
  const [customDraft, setCustomDraft] = useState(settings.customTheme || DEFAULT_CUSTOM);
  const [copied, setCopied] = useState(false);

  const isWindows = defaultAppStatus?.supported === true;
  const fonts = settings.fonts;
  const setFonts = (patch) => updateSetting('fonts', { ...fonts, ...patch });

  const sections = [
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'fonts', label: 'Fonts', icon: TextAa },
    { id: 'editor', label: 'Code Editor', icon: Code },
    { id: 'markdown', label: 'Markdown', icon: MarkdownLogo },
    { id: 'printing', label: 'Printing', icon: Printer },
    ...(isWindows ? [{ id: 'windows', label: 'Windows', icon: WindowsLogo }] : []),
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'about', label: 'About', icon: Info }
  ];
  // An unknown or unavailable page (Windows, off Windows) opens Appearance instead.
  const current = sections.some((s) => s.id === section) ? section : 'appearance';

  /*
   * Ids for aria-labelledby/aria-describedby: each control is named by its setting's visible
   * label rather than by a second, hidden copy of the text.
   */
  const uid = useId();
  const idFor = (key) => `${uid}-${key}`;

  const platform = window.electronAPI?.platform;
  // Until App stores them, fall back to the 1.14.0 defaults (see the settings contract).
  const spellcheckOn = typeof settings.spellcheck === 'boolean' ? settings.spellcheck : platform === 'win32';
  const remoteImagesOn = settings.remoteImages === true;

  /* ── Modal focus: in on open, trapped while open, back to the editor on close ─────────────── */
  const dialogRef = useRef(null);
  useDialogFocus(dialogRef, {
    initialFocus: () => dialogRef.current?.querySelector('.settings-nav-item.active'),
    // While a binding is recording, Escape cancels it (and is not recorded); otherwise it closes.
    onEscape: () => (activeShortcutRebind ? setActiveShortcutRebind(null) : onClose()),
    // Tab may be part of the shortcut being recorded, so the recorder must get it.
    trapTab: !activeShortcutRebind
  });

  /*
   * Closing Settings stops the recorder. Up to 1.13 it stayed armed after Settings closed, and the
   * next key typed anywhere, even a plain letter in the editor, became that action's shortcut.
   * The latest setter is read through a ref so the cleanup runs once, on unmount.
   */
  const stopRecordingRef = useRef(setActiveShortcutRebind);
  useEffect(() => {
    stopRecordingRef.current = setActiveShortcutRebind;
  });
  useEffect(() => () => stopRecordingRef.current?.(null), []);

  const refreshCoverage = () => {
    if (window.electronAPI?.getAssociationCoverage) {
      window.electronAPI.getAssociationCoverage().then(setCoverage).catch(() => {});
    }
    if (window.electronAPI?.getClassicMenu) {
      window.electronAPI.getClassicMenu().then(setClassicMenu).catch(() => {});
    }
  };

  const toggleClassicMenu = async (enabled) => {
    const res = await window.electronAPI?.setClassicMenu?.(enabled);
    if (res?.ok) {
      setClassicMenu(enabled);
      setExplorerRestartNeeded(true);
    }
  };

  /* Association coverage runs a registry sweep, fetched only when its section opens. */
  useEffect(() => {
    if (current === 'windows') refreshCoverage();
  }, [current]);

  const repairTypes = async () => {
    setRepairBusy(true);
    const res = await window.electronAPI?.repairAssociations?.();
    setRepairResult(res || null);
    refreshCoverage();
    setRepairBusy(false);
  };

  const overrides = Object.entries(fonts.perType);
  const overridableExts = CODE_EXTENSIONS.filter((ext) => !(ext in fonts.perType));

  const addOverride = () => {
    if (!newOverrideExt) return;
    setFonts({ perType: { ...fonts.perType, [newOverrideExt]: fonts.code } });
    setNewOverrideExt('');
  };

  const removeOverride = (ext) => {
    const next = { ...fonts.perType };
    delete next[ext];
    setFonts({ perType: next });
  };

  /*
   * Duplicate bindings, flagged inline rather than silently letting first-match win. Compared in
   * normalized form, so "Control+k" and "Control+K" (or a legacy "Control++" and "Control+Plus")
   * count as the same binding.
   */
  const conflicts = useMemo(() => {
    const seen = {};
    const dupes = new Set();
    for (const { id } of SHORTCUT_ACTIONS) {
      const b = normalizeBinding(settings.shortcuts[id]);
      if (!b) continue;
      if (seen[b]) {
        dupes.add(b);
      }
      seen[b] = id;
    }
    return dupes;
  }, [settings.shortcuts]);
  const isConflicted = (id) => conflicts.has(normalizeBinding(settings.shortcuts[id]));

  const saveCustomTheme = () => {
    updateSetting('customTheme', customDraft);
    updateSetting('theme', 'custom');
  };

  const removeCustomTheme = () => {
    if (settings.theme === 'custom') updateSetting('theme', 'fate');
    updateSetting('customTheme', null);
    setCustomDraft(DEFAULT_CUSTOM);
  };

  const copyCustomCss = async () => {
    try {
      await navigator.clipboard.writeText(customThemeCss(customDraft));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable; nothing sensible to do */
    }
  };

  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idFor('title')}
        tabIndex={-1}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">
            <h2 id={idFor('title')}>Settings</h2>
          </div>
          {sections.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                className={`settings-nav-item ${current === s.id ? 'active' : ''}`}
                aria-current={current === s.id ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                <Icon size={16} weight="duotone" />
                {s.label}
              </button>
            );
          })}
          <div className="settings-nav-foot">
            <span className="settings-nav-version">v{appVersion || '-'}</span>
          </div>
        </nav>

        <div className="settings-content">
          <div className="settings-content-head">
            <h3 className="section-label">{sections.find((s) => s.id === current)?.label}</h3>
            <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close settings">
              <X size={18} weight="bold" />
            </button>
          </div>

          <div className="settings-body">
            {/* ── APPEARANCE ─────────────────────────────────────────────────────────────── */}
            {current === 'appearance' && (
              <>
                <div className="setting-group">
                  <span className="group-caption">Theme</span>
                  <div className="theme-grid">
                    {THEMES.map((t) => (
                      <button
                        key={t.value}
                        data-theme={t.value}
                        className={`theme-card ${settings.theme === t.value ? 'selected' : ''}`}
                        onClick={() => updateSetting('theme', t.value)}
                        aria-pressed={settings.theme === t.value}
                      >
                        <span className="tc-preview">
                          <span className="tc-chrome" />
                          <span className="tc-line wide" />
                          <span className="tc-line" />
                          <span className="tc-line narrow" />
                          <span className="tc-accent" />
                        </span>
                        <span className="tc-label">{t.label}</span>
                        <span className="tc-sub">{t.sub}</span>
                        {settings.theme === t.value && (
                          <CheckCircle size={15} weight="fill" className="tc-check" />
                        )}
                      </button>
                    ))}
                    {settings.customTheme && (
                      <button
                        data-theme="custom"
                        className={`theme-card ${settings.theme === 'custom' ? 'selected' : ''}`}
                        onClick={() => updateSetting('theme', 'custom')}
                        aria-pressed={settings.theme === 'custom'}
                      >
                        <span className="tc-preview">
                          <span className="tc-chrome" />
                          <span className="tc-line wide" />
                          <span className="tc-line" />
                          <span className="tc-line narrow" />
                          <span className="tc-accent" />
                        </span>
                        <span className="tc-label">Custom</span>
                        <span className="tc-sub">Your palette</span>
                        {settings.theme === 'custom' && (
                          <CheckCircle size={15} weight="fill" className="tc-check" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <div className="setting-group">
                  <span className="group-caption">Custom theme</span>
                  <p className="setting-hint group-hint">
                    Pick seven colours and FATE derives the rest (borders, glows, gradients and a full
                    syntax palette), so the result hangs together like the built-in themes. Copy CSS
                    exports the generated token block.
                  </p>
                  <div className="custom-theme-grid">
                    {CUSTOM_FIELDS.map((f) => (
                      <label className="custom-color" key={f.key}>
                        <input
                          type="color"
                          value={customDraft[f.key]}
                          onChange={(e) => setCustomDraft((c) => ({ ...c, [f.key]: e.target.value.toUpperCase() }))}
                        />
                        <span className="custom-color-label">{f.label}</span>
                        <code className="custom-color-hex">{customDraft[f.key]}</code>
                      </label>
                    ))}
                  </div>
                  <div className="custom-theme-actions">
                    <button className="btn btn-primary btn-compact" onClick={saveCustomTheme}>
                      <Check size={14} weight="bold" />
                      {settings.customTheme ? 'Update & apply' : 'Create & apply'}
                    </button>
                    <button className="btn btn-secondary btn-compact" onClick={copyCustomCss}>
                      <Copy size={14} weight="bold" />
                      {copied ? 'Copied!' : 'Copy CSS'}
                    </button>
                    {settings.customTheme && (
                      <button className="btn btn-secondary btn-compact" onClick={removeCustomTheme}>
                        <Trash size={14} weight="bold" />
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                <div className="setting-group">
                  <span className="group-caption">Layout &amp; startup</span>
                  <div className="setting-item setting-item-stacked">
                    <div className="setting-label-block">
                      <span className="setting-label" id={idFor('sidebar')}>Default sidebar width</span>
                      <span className="setting-hint" id={idFor('sidebar-hint')}>
                        Width of a Markdown document&apos;s contents sidebar, from {SIDEBAR_WIDTH_MIN} to{' '}
                        {SIDEBAR_WIDTH_MAX} pixels.
                      </span>
                    </div>
                    <SidebarWidthField
                      value={settings.sidebarWidth}
                      labelledBy={idFor('sidebar')}
                      describedBy={idFor('sidebar-hint')}
                      onCommit={(width) => {
                        updateSetting('sidebarWidth', width);
                        onSidebarWidthChange(width);
                      }}
                    />
                  </div>
                  <div className="setting-item setting-item-stacked">
                    <div className="setting-label-block">
                      <span className="setting-label" id={idFor('restore')}>Reopen last session&apos;s tabs on launch</span>
                      <span className="setting-hint" id={idFor('restore-hint')}>
                        Off means FATE closes your tabs when you quit and starts on the home screen
                        next time, without keeping the list of what you had open. Either way, quitting
                        with unsaved work asks you to save or discard it first, tab by tab.
                      </span>
                    </div>
                    <Switch
                      checked={settings.restoreSession}
                      onChange={(v) => updateSetting('restoreSession', v)}
                      labelledBy={idFor('restore')}
                      describedBy={idFor('restore-hint')}
                    />
                  </div>
                </div>
              </>
            )}

            {/* ── FONTS ──────────────────────────────────────────────────────────────────── */}
            {current === 'fonts' && (
              <>
                <div className="setting-group">
                  <span className="group-caption">Interface</span>
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('font-ui')}>Application font</span>
                    <FontPicker labelledBy={idFor('font-ui')} systemFonts={systemFonts} value={fonts.ui} options={PROSE_FONTS} onChange={(id) => setFonts({ ui: id })} />
                  </div>
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('font-display')}>UI Title / Display font</span>
                    <FontPicker labelledBy={idFor('font-display')} systemFonts={systemFonts} value={fonts.display} options={PROSE_FONTS} onChange={(id) => setFonts({ display: id })} />
                  </div>
                </div>

                <div className="setting-group">
                  <span className="group-caption">Markdown documents</span>
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('font-md')}>Document body font</span>
                    <FontPicker labelledBy={idFor('font-md')} systemFonts={systemFonts} value={fonts.markdown} options={PROSE_FONTS} onChange={(id) => setFonts({ markdown: id })} />
                  </div>
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('font-heading')}>Document heading font</span>
                    <FontPicker labelledBy={idFor('font-heading')} systemFonts={systemFonts} value={fonts.heading} options={PROSE_FONTS} onChange={(id) => setFonts({ heading: id })} />
                  </div>
                  <SizeSlider label="Document text size" value={fonts.markdownSize} min={12} max={22} onChange={(v) => setFonts({ markdownSize: v })} />
                </div>

                <div className="setting-group">
                  <span className="group-caption">Code</span>
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('font-code')}>Code font</span>
                    <FontPicker mono labelledBy={idFor('font-code')} systemFonts={systemFonts} value={fonts.code} options={CODE_FONTS} onChange={(id) => setFonts({ code: id })} />
                  </div>
                  <SizeSlider label="Editor text size" value={fonts.editorSize} min={10} max={20} onChange={(v) => setFonts({ editorSize: v })} />
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('ligatures')}>Font ligatures</span>
                    <Switch
                      checked={fonts.ligatures}
                      onChange={(v) => setFonts({ ligatures: v })}
                      labelledBy={idFor('ligatures')}
                    />
                  </div>
                </div>

                <div className="setting-group">
                  <span className="group-caption">Per-file-type fonts</span>
                  <p className="setting-hint group-hint">
                    Give any file type its own code font, and every open tab of that type uses it.
                    Types without an override use the code font above.
                  </p>

                  {overrides.map(([ext, fontId]) => (
                    <div className="override-row" key={ext}>
                      <code className="override-ext" id={idFor(`override-${ext}`)}>.{ext}</code>
                      <FontPicker
                        labelledBy={idFor(`override-${ext}`)}
                        systemFonts={systemFonts}
                        mono
                        value={fontId}
                        options={CODE_FONTS}
                        onChange={(id) => setFonts({ perType: { ...fonts.perType, [ext]: id } })}
                      />
                      <button className="icon-btn override-remove" onClick={() => removeOverride(ext)} title={`Remove .${ext} override`}>
                        <Trash size={14} weight="bold" />
                      </button>
                    </div>
                  ))}

                  <div className="override-row override-add">
                    <select value={newOverrideExt} onChange={(e) => setNewOverrideExt(e.target.value)} aria-label="File type to override">
                      <option value="">Choose a file type…</option>
                      {overridableExts.map((ext) => (
                        <option key={ext} value={ext}>.{ext}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary btn-compact" onClick={addOverride} disabled={!newOverrideExt}>
                      <Plus size={14} weight="bold" />
                      Add override
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* ── CODE EDITOR ────────────────────────────────────────────────────────────── */}
            {current === 'editor' && (
              <div className="setting-group">
                <div className="setting-item">
                  <span className="setting-label" id={idFor('wrap')}>Wrap long lines</span>
                  <Switch
                    checked={settings.editorWrap}
                    onChange={(v) => updateSetting('editorWrap', v)}
                    labelledBy={idFor('wrap')}
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label" id={idFor('indent')}>Indent size</span>
                  <select
                    value={settings.editorTabSize}
                    onChange={(e) => updateSetting('editorTabSize', parseInt(e.target.value, 10))}
                    aria-labelledby={idFor('indent')}
                  >
                    <option value={2}>2 spaces</option>
                    <option value={4}>4 spaces</option>
                    <option value={8}>8 spaces</option>
                  </select>
                </div>
                <div className="setting-item setting-item-stacked">
                  <div className="setting-label-block">
                    <span className="setting-label" id={idFor('lint')}>Highlight syntax errors</span>
                    <span className="setting-hint" id={idFor('lint-hint')}>
                      Underlines code the language parser can&apos;t make sense of (missing
                      brackets, unclosed strings, stray tokens), with a marker in the gutter.
                      Works for languages with structural parsers (JavaScript, TypeScript, HTML,
                      CSS, JSON, Python and most others); shell-style languages report nothing
                      rather than guessing.
                    </span>
                  </div>
                  <Switch
                    checked={settings.editorLint}
                    onChange={(v) => updateSetting('editorLint', v)}
                    labelledBy={idFor('lint')}
                    describedBy={idFor('lint-hint')}
                  />
                </div>
                <div className="setting-item setting-item-stacked">
                  <div className="setting-label-block">
                    <span className="setting-label">Editing</span>
                    <span className="setting-hint">
                      Code files open straight into the editor; markdown opens in the reading view
                      with an <code>Edit</code> button (and live preview) in the header. New files
                      (<InlineBinding binding={settings.shortcuts.newFile} />) save as any supported
                      format. Fonts live in the Fonts section; every shortcut is rebindable under
                      Shortcuts.
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ── MARKDOWN (1.14.0) ──────────────────────────────────────────────────────────
                 Spell check and remote images: both are about what leaves the machine, so each
                 hint says plainly what turning it on sends where. */}
            {current === 'markdown' && (
              <>
                <div className="setting-group">
                  <span className="group-caption">Editing</span>
                  <div className="setting-item setting-item-stacked">
                    <div className="setting-label-block">
                      <span className="setting-label" id={idFor('spellcheck')}>Spell check while editing Markdown</span>
                      <span className="setting-hint" id={idFor('spellcheck-hint')}>
                        Underlines misspelled words in Edit mode.
                        {platform === 'linux' && (
                          <> Turning it on downloads a dictionary from Google once.</>
                        )}
                      </span>
                    </div>
                    <Switch
                      checked={spellcheckOn}
                      onChange={(v) => updateSetting('spellcheck', v)}
                      labelledBy={idFor('spellcheck')}
                      describedBy={idFor('spellcheck-hint')}
                    />
                  </div>
                </div>

                <div className="setting-group">
                  <span className="group-caption">Privacy</span>
                  <div className="setting-item setting-item-stacked">
                    <div className="setting-label-block">
                      <span className="setting-label" id={idFor('remote-images')}>
                        Load images from the internet in Markdown documents
                      </span>
                      <span className="setting-hint" id={idFor('remote-images-hint')}>
                        Off by default for privacy: loading a remote image tells its server that
                        you opened the document, and when. Images stored on this computer are not
                        affected.
                      </span>
                    </div>
                    <Switch
                      checked={remoteImagesOn}
                      onChange={(v) => updateSetting('remoteImages', v)}
                      labelledBy={idFor('remote-images')}
                      describedBy={idFor('remote-images-hint')}
                    />
                  </div>
                </div>
              </>
            )}

            {/* ── PRINTING ───────────────────────────────────────────────────────────────── */}
            {current === 'printing' && (
              <div className="setting-group">
                <div className="setting-item">
                  <span className="setting-label" id={idFor('paper')}>Paper size</span>
                  <select
                    value={settings.printPageSize}
                    onChange={(e) => updateSetting('printPageSize', e.target.value)}
                    aria-labelledby={idFor('paper')}
                  >
                    {PAGE_SIZES.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div className="setting-item">
                  <span className="setting-label" id={idFor('landscape')}>Landscape</span>
                  <Switch
                    checked={settings.printLandscape}
                    onChange={(v) => updateSetting('printLandscape', v)}
                    labelledBy={idFor('landscape')}
                  />
                </div>
                <div className="setting-item setting-item-stacked">
                  <div className="setting-label-block">
                    <span className="setting-label">Preview &amp; export</span>
                    <span className="setting-hint">
                      Printing opens a page-by-page preview. Exports carry heading bookmarks and
                      page numbers, and always print on white regardless of your theme. Code files
                      print the full buffer in black monospace; with a split open, only the active
                      pane prints.
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ── WINDOWS ────────────────────────────────────────────────────────────────── */}
            {current === 'windows' && isWindows && (
              <>
                <div className="setting-group">
                  <span className="group-caption">Markdown default</span>
                  <div className="setting-item setting-item-stacked">
                    <div className="setting-label-block">
                      <span className="setting-label">Default app for Markdown files</span>
                      <span className="setting-hint">
                        {defaultAppStatus.isDefault ? (
                          <>
                            <CheckCircle size={12} weight="fill" className="hint-ok" />
                            {' '}FATE currently opens <code>.md</code> files. Manage opens Windows
                            Settings if you want to change it.
                          </>
                        ) : (
                          <>
                            {defaultAppStatus.currentProgId
                              ? <>Another app currently opens <code>.md</code> files. </>
                              : <>No app is set for <code>.md</code> files yet. </>}
                            Opens FATE&apos;s page in Windows Settings, where you pick FATE for{' '}
                            <code>.md</code>. Windows requires you to confirm this itself.
                          </>
                        )}
                      </span>
                    </div>
                    <button
                      className={`btn ${defaultAppStatus.isDefault ? 'btn-secondary' : 'btn-primary'} btn-compact`}
                      onClick={requestDefaultApp}
                    >
                      <ArrowSquareOut size={15} weight="bold" />
                      {defaultAppStatus.isDefault ? 'Manage' : 'Set as default'}
                    </button>
                  </div>
                </div>

                <div className="setting-group">
                  <span className="group-caption">All supported file types</span>
                  <div className="coverage-card">
                    <div className="coverage-numbers">
                      <span className="coverage-count">
                        {coverage ? coverage.ours : '…'}
                        <span className="coverage-total"> / {coverage ? coverage.total : '…'}</span>
                      </span>
                      <span className="coverage-caption">file types currently open with FATE</span>
                    </div>
                    <div className="coverage-actions">
                      {coverage && coverage.repairable?.length > 0 && (
                        <button className="btn btn-primary btn-compact" onClick={repairTypes} disabled={repairBusy}>
                          <ArrowCounterClockwise size={14} weight="bold" />
                          {repairBusy ? 'Repairing…' : `Repair ${coverage.repairable.length} broken types`}
                        </button>
                      )}
                      <button className="btn btn-secondary btn-compact" onClick={requestDefaultApp}>
                        <ArrowSquareOut size={14} weight="bold" />
                        Choose in Windows
                      </button>
                    </div>
                  </div>
                  <p className="setting-hint group-hint">
                    The count is what double-clicking would <em>actually</em> launch: FATE asks the
                    shell, the same way Explorer does.
                    {coverage && coverage.unowned?.length > 0 && (
                      <> {coverage.unowned.length} type{coverage.unowned.length === 1 ? ' has' : 's have'} no
                      handler at all; {coverage.otherApp?.length || 0} belong to another app.</>
                    )}{' '}
                    Windows only lets an application be <em>offered</em>; the confirmation itself has
                    to happen in Windows Settings, one type at a time. <strong>Choose in Windows</strong>
                    opens FATE&apos;s page there with every supported type listed.
                  </p>
                  {coverage && coverage.repairable?.length > 0 && (
                    <p className="setting-hint group-hint">
                      <strong>Repair</strong> clears registry entries FATE itself wrote in 1.10–1.11.
                      They were meant to claim these types and instead left them with no handler at
                      all. Removing them lets Windows fall back to FATE.
                    </p>
                  )}
                  {repairResult?.ok && (
                    <p className="setting-hint group-hint">
                      Repaired {repairResult.fixed?.length || 0} file type
                      {repairResult.fixed?.length === 1 ? '' : 's'}
                      {repairResult.restored?.length > 0 &&
                        `, and gave .${repairResult.restored.join(', .')} back to the command processor`}
                      .
                    </p>
                  )}
                  <p className="setting-hint group-hint">
                    <strong>.bat</strong> and <strong>.cmd</strong> are deliberately not in this list.
                    Windows runs them through the command processor, which is not an app you can pick
                    again in the &quot;Choose a default&quot; dialog, so an editor that takes them
                    leaves no way back. FATE still opens both from the Open dialog, drag &amp; drop and
                    <em> Edit in FATE</em>; it just never registers to own them.
                  </p>
                </div>

                <div className="setting-group">
                  <span className="group-caption">Context menu</span>
                  <div className="setting-item setting-item-stacked">
                    <div className="setting-label-block">
                      <span className="setting-label">&quot;Edit in FATE&quot; placement</span>
                      <span className="setting-hint">
                        FATE adds <strong>Edit in FATE</strong> to every file&apos;s right-click menu.
                        Windows 11 tucks classic entries under <em>Show more options</em>; top-level
                        placement requires a signed system component that apps like Notepad++ ship
                        separately. The switch below is the practical alternative: it restores the
                        full classic menu everywhere, with Edit in FATE at the top level.
                      </span>
                    </div>
                  </div>
                  <div className="setting-item">
                    <span className="setting-label" id={idFor('classic-menu')}>Always show full context menus</span>
                    <Switch
                      checked={classicMenu === true}
                      disabled={classicMenu === null}
                      onChange={toggleClassicMenu}
                      labelledBy={idFor('classic-menu')}
                    />
                  </div>
                  {explorerRestartNeeded && (
                    <div className="setting-item setting-item-stacked">
                      <div className="setting-label-block">
                        <span className="setting-hint">
                          Takes effect after Windows Explorer restarts. Restarting closes and
                          reopens your Explorer windows.
                        </span>
                      </div>
                      <button
                        className="btn btn-primary btn-compact"
                        onClick={() => {
                          window.electronAPI?.restartExplorer?.();
                          setExplorerRestartNeeded(false);
                        }}
                      >
                        <ArrowCounterClockwise size={14} weight="bold" />
                        Restart Explorer now
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── SHORTCUTS ──────────────────────────────────────────────────────────────── */}
            {current === 'shortcuts' && (
              <>
                <div className="setting-group">
                  <div className="shortcuts-head">
                    <span className="group-caption">Rebindable: click a binding, then press keys</span>
                    <button
                      className="link-btn"
                      onClick={() => updateSetting('shortcuts', { ...DEFAULT_SHORTCUTS })}
                      title="Reset every shortcut to its default"
                    >
                      <ArrowCounterClockwise size={13} weight="bold" />
                      Reset all
                    </button>
                  </div>
                  {conflicts.size > 0 && (
                    <p className="setting-hint group-hint shortcut-conflict">
                      <Warning size={13} weight="fill" /> Two actions share a binding. The one
                      higher in this list wins. Rebind one of them.
                    </p>
                  )}
                  {/* Announced when recording starts, so a screen reader user knows what to press. */}
                  <p className="setting-hint group-hint shortcut-recording-hint" role="status">
                    {activeShortcutRebind
                      ? 'Press the new shortcut: Ctrl or Alt with a key, or a function key (F1–F12). Esc cancels.'
                      : ''}
                  </p>
                  {SHORTCUT_ACTIONS.map((a) => {
                    const recording = activeShortcutRebind === a.id;
                    const conflicted = isConflicted(a.id);
                    return (
                      <div className="setting-item" key={a.id}>
                        <span className={`setting-label ${conflicted ? 'conflicted' : ''}`} id={idFor(`sc-${a.id}`)}>
                          {a.label}
                        </span>
                        <button
                          className={`shortcut-btn ${recording ? 'recording' : ''} ${conflicted ? 'conflicted' : ''}`}
                          onClick={() => setActiveShortcutRebind(recording ? null : a.id)}
                          aria-pressed={recording}
                          aria-label={`${a.label}: ${recording ? 'press the new shortcut' : formatShortcutLabel(settings.shortcuts[a.id])}`}
                        >
                          {recording
                            ? 'Press keys…'
                            : <BindingChips binding={settings.shortcuts[a.id]} />}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="setting-group">
                  <span className="group-caption">Fixed</span>
                  {FIXED_SHORTCUTS.map((s) => (
                    <div className="setting-item" key={s.label}>
                      <span className="setting-label">{s.label}</span>
                      <span className="kbd-group">
                        {s.keys.map((k) => <kbd key={k}>{k}</kbd>)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── ABOUT ──────────────────────────────────────────────────────────────────── */}
            {current === 'about' && (
              <>
                <div className="setting-group">
                  <span className="group-caption">Updates</span>
                  {runtimeInfo?.updates?.managed ? (
                    <div className="setting-item setting-item-stacked">
                      <div className="setting-label-block">
                        <span className="setting-label">
                          {runtimeInfo.windowsStore ? 'Microsoft Store build' : `Managed by ${runtimeInfo.updates.label}`}
                        </span>
                        <span className="setting-hint">
                          {runtimeInfo.windowsStore
                            ? 'This copy of FATE is managed by the Microsoft Store, which delivers its updates automatically. The update button in the status bar opens the Store’s downloads page.'
                            : `This copy of FATE was installed through ${runtimeInfo.updates.label}, which delivers its updates on its own schedule, so FATE never updates itself here. The update button in the status bar opens the latest release notes.`}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="setting-item">
                      <span className="setting-label" id={idFor('updates')}>Automatic updates</span>
                      <Switch
                        checked={settings.autoUpdatesEnabled}
                        onChange={(v) => updateSetting('autoUpdatesEnabled', v)}
                        labelledBy={idFor('updates')}
                      />
                    </div>
                  )}
                </div>

                <div className="setting-group setting-group-about">
                  <div className="about-row">
                    <img src={fateLogo} alt="" className="about-badge" />
                    <div className="about-text">
                      <span className="about-name">FATE <span className="about-version">v{appVersion}</span></span>
                      <span className="about-sub">Formatted Article &amp; Text Editor</span>
                      <span className="about-credit">
                        &copy; {new Date().getFullYear()} VagueDustin Enterprises&trade; &middot; All rights reserved
                      </span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
