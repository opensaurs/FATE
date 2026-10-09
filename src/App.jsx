import { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { EditorView } from '@codemirror/view';
import { undo as undoEdit, redo as redoEdit } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import {
  UploadSimple, FileText, FileCode, CircleNotch, Gear, X, Plus, House, FilePlus,
  Printer, FilePdf, FloppyDisk, FolderOpen, ClockCounterClockwise, CheckCircle, Trash,
  Warning, PencilSimple, Eye, SquareSplitHorizontal, GitDiff, Palette, Keyboard,
  ArrowsOutSimple, MagnifyingGlass, MarkdownLogo, ArrowLineDown
} from '@phosphor-icons/react';
import fateLogo from './assets/FATE-Square-Icon.png';
import Starfield from './components/Starfield.jsx';
import CodeEditor from './components/CodeEditor.jsx';
import MarkdownView from './components/MarkdownView.jsx';
import MarkdownEditView from './components/MarkdownEditView.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import DiffView from './components/DiffView.jsx';
import DocBar from './components/DocBar.jsx';
import FormatStatus from './components/FormatStatus.jsx';
import IndentStatus from './components/IndentStatus.jsx';
import { renderMarkdown } from './markdown.js';
import { renderSafely } from './renderSafely.js';
import { installPreviewClipboard, selectPreviewDocument } from './previewClipboard.js';
import { scrollIntoPreview } from './previewLinks.js';
import { detectLanguage } from './languageDetect.js';
import { createPaletteModes } from './paletteModes.js';
import { indentForDocument, effectiveIndent, requiresTabs } from './indentDetect.js';
import { EditorPrefsContext } from './editorPrefs.js';
import {
  fileKindForName, kindForOpen, couldBeMarkdown, extensionOf, looksBinary,
  MARKDOWN_RENDER_LIMIT, LARGE_FILE_LIMIT
} from './fileKinds.js';
import { defaultFormat, formatChanged, toggledEol } from './docFormat.js';
import {
  newBackupId, backupPayload, planRestore, untitledNumber, sameSignature, setCrashFlusher
} from './hotExit.js';
import { resolveFonts, applyFonts, editorFontFor, DEFAULT_FONTS } from './fonts.js';
import {
  DEFAULT_THEME, resolveTheme, THEMES, SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, resolveShortcuts,
  matchesShortcut, bindingFromEvent, isAllowedShortcut, formatShortcutLabel, shortcutParts,
  clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH
} from './settingsMeta.js';
import { resolveCustomTheme, applyCustomTheme } from './themeCustom.js';
import './App.css';

/** Compact relative time for the recents list. Deliberately coarse; exact minutes aren't useful. */
function relativeTime(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Shorten a directory path for display, keeping the tail (the informative end). */
function shortenDir(dir, max = 38) {
  if (!dir || dir.length <= max) return dir;
  return '…' + dir.slice(-(max - 1));
}

/** Case-insensitive path key. Windows paths compare that way. */
/*
 * Comparable key for a path (tab dedupe, the file-changed router). Windows and macOS compare
 * paths case-insensitively; Linux does not: `Notes.md` and `notes.md` are two files there and
 * folding case would merge their tabs. Mirrors watchKey() in electron/main.cjs.
 */
const CASE_INSENSITIVE_PATHS = window.electronAPI?.platform !== 'linux';
function pathKey(p) {
  const s = p || '';
  return CASE_INSENSITIVE_PATHS ? s.replace(/\//g, '\\').toLowerCase() : s;
}

/** Unique by key, first occurrence kept (session paths: duplicates there compounded per launch). */
function uniqueBy(list, keyOf) {
  const seen = new Set();
  return list.filter((item) => {
    const k = keyOf(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** File name from a path, either separator. */
function baseName(p) {
  return (p || '').replace(/^.*[\\/]/, '');
}

const megabytes = (chars) => (chars / 1048576).toFixed(1);

/** Wall-clock milliseconds, for timers that run outside render (the hot-exit tick). */
const nowMs = () => Date.now();

/*
 * Display helpers for shortcut bindings. Every tooltip and keycap in the UI renders the LIVE
 * binding through these; a hardcoded "(Ctrl+N)" in a title is a lie the moment the user rebinds.
 * Both go through settingsMeta, which knows the stored format: splitting on "+" here broke on a
 * binding of the + key itself (L9), which is stored as "Plus".
 */
const fmtShortcut = (binding) => formatShortcutLabel(binding);
const kbdChips = (binding) => shortcutParts(binding);

/*
 * Where a bare Escape belongs to what has focus rather than to the app (M1). Escape is the
 * default binding of "Close tab / dismiss (alternate)", and up to 1.13 it closed the tab from
 * anywhere: in the editor with nothing to dismiss, a clean tab vanished with its undo history,
 * caret and folds. Now it only acts as a shortcut when focus is on nothing in particular (the
 * reading view, which takes no focus, or <body>). Editors, fields, buttons and other controls,
 * menus, find bars and dialogs keep their Escape, whether or not they do anything with it.
 */
const ESCAPE_OWNERS = [
  '.cm-editor', 'input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
  'button', 'a[href]', 'summary', '[role="button"]', '[role="tab"]', '[role="menu"]',
  '[role^="menuitem"]', '[role="listbox"]', '[role="option"]', '[role="combobox"]',
  '[role="dialog"]', '[role="alertdialog"]', '[role="search"]', '.format-menu', '.find-bar'
].join(',');

function escapeOwnedBy(target) {
  return target instanceof Element && target !== document.body && !!target.closest(ESCAPE_OWNERS);
}

/** Is this keydown a bare Escape (no modifiers)? Only that one is held back by focus (M1). */
const isBareEscape = (e) => e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;

/** The format a new Untitled buffer is saved with (UTF-8, the platform's line break). */
const UNTITLED_FORMAT = defaultFormat(window.electronAPI?.platform);

/*
 * Hot-exit timing. A dirty tab is backed up once its text has held still for a tick, so roughly a
 * second after typing pauses, and during a long burst of typing at least every few seconds.
 */
const BACKUP_TICK_MS = 500;
const BACKUP_MAX_WAIT_MS = 4000;
/** A backup write that failed (disk full, main busy) is tried again after this long. */
const BACKUP_RETRY_MS = 5000;
/** How long a path-backed backup waits for its file's tab before it is restored without one. */
const RESTORE_TIMEOUT_MS = 15000;

/** Labels for the app menu's fixed shortcuts (CodeMirror's own keys; not rebindable). */
const FIXED_MENU_SHORTCUTS = { find: 'Control+F', undo: 'Control+Z', redo: 'Control+Y' };

/**
 * Every doc object goes through here on its way into state: `dirty` (what the tab dot, title,
 * Save button and every guard read) is derived, never set directly. A tab is dirty when its text
 * differs from the baseline on disk (`textDirty`, mirrored from the editor) OR its format was
 * switched and not yet saved (an EOL or encoding change alone is still an unsaved change).
 */
function finalizeDoc(d) {
  const dirty = !!d.textDirty || formatChanged(d);
  return d.dirty === dirty ? d : { ...d, dirty };
}

/**
 * Render fields for a Markdown doc. Never throws and never runs inside a state updater (H3): a
 * render that fails yields the text itself, escaped, in a <pre>, and `failed` tells the caller to
 * say so in the status bar. `options` go to renderMarkdown ({ remoteImages }).
 */
function renderFields(content, fPath, options) {
  const r = renderSafely(renderMarkdown, content, fPath, options);
  if (r.renderFailed) console.error('Markdown render failed; showing plain text instead:', r.error);
  return {
    failed: r.renderFailed,
    fields: { html: r.html, toc: r.toc, readMins: r.readMins, hasMermaid: r.hasMermaid, remoteImageCount: r.remoteImageCount ?? 0 }
  };
}

const renderFailedMessage = (name) => `Couldn't render ${name} as Markdown, so it's shown as plain text`;

/** Save As's suggested name: Untitled buffers gain an extension, everything else keeps its name. */
function suggestedSaveName(doc) {
  if (!doc.untitled || extensionOf(doc.name)) return doc.name;
  return `${doc.name}.${doc.kind === 'markdown' ? 'md' : 'txt'}`;
}

function App() {
  /*
   * ── Tabs ────────────────────────────────────────────────────────────────────────────────────
   * `docs` is the open-tab list, in tab-strip order. Every doc has
   *   { id, kind, name, path, untitled?, dirty, textDirty, format, savedFormat, backupId,
   *     diskChange, diskDeleted, notice }
   * and then either
   *   kind:'markdown'  { source, savedSource, html, toc, readMins, hasMermaid, remoteImageCount, editMode }
   *   kind:'code'      { codeContent, savedContent?, langName, plainText, largeFile, follow }
   * (codeContent/source seed the CodeMirror instance, which owns the buffer after mount.) Both
   * kinds carry `indent`: how the document indents ({ useTabs, size? } or null; indentDetect.js).
   *
   * Since 1.14.0 a doc knows its BASELINE, the text last known to be on disk: `savedSource` for
   * Markdown (set on open, save and reload), the editor's own baseline for code (`savedContent`
   * only seeds it when it differs from the initial text, e.g. a restored backup). `format` is how
   * the next save writes the file, `savedFormat` how it is stored now (see docFormat.js).
   * `diskChange` ({ content, format }) and `diskDeleted` drive the bars over a tab whose file
   * changed or vanished underneath unsaved work; `notice` is an informational bar.
   *
   * `activeId === null` with docs open = home screen behind the tab strip. `splitId` pins a second
   * doc into a right-hand pane; `diffData` (a snapshot) swaps the split for a side-by-side diff.
   * Every pane stays MOUNTED while its tab is open; that is what preserves scroll position,
   * cursor, selection and undo history across switches. Do not "optimise" this into unmounting.
   *
   * The FOCUSED doc (L3) is the one commands act on: the split pane's while it has focus (focus
   * or a click inside it, `paneFocusId`), else the active tab's. Saving, closing, Edit/View,
   * printing, find, undo, the header and the status bar (Ln/Col, encoding, indentation) all
   * follow it; up to 1.13 they all acted on the left pane whatever the right one was doing. The
   * right pane never becomes `activeId`: the tab strip's selection stays where the user put it.
   */
  const [docs, setDocs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [splitId, setSplitId] = useState(null);
  const [diffData, setDiffData] = useState(null);
  const [paneFocusId, setPaneFocusId] = useState(null);
  const [focusMode, setFocusMode] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  /** What the palette opens with ('' normally, ':' go to line, '@' go to symbol), and its modes. */
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteModes, setPaletteModes] = useState(null);

  const [appVersion, setAppVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateAction, setUpdateAction] = useState(null);
  const [runtimeInfo, setRuntimeInfo] = useState({ windowsStore: false });
  /** Font families installed on this machine, for Settings → Fonts (fetched once, local-only). */
  const [systemFonts, setSystemFonts] = useState([]);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [recentFiles, setRecentFiles] = useState([]);
  const [defaultAppStatus, setDefaultAppStatus] = useState(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  /**
   * What a print job prints, for the doc `docId`; see runPrintJob. { kind:'code', text } for a
   * code buffer, { kind:'markdown', markup } for a Markdown tab in Edit mode (printed RENDERED),
   * { kind:'view' } for a reading view in the split pane (printed as it is, the pane swapped in).
   */
  const [printSnapshot, setPrintSnapshot] = useState(null);

  const [showSettings, setShowSettings] = useState(false);
  /** The Settings page to open on (SettingsModal's initialSection); every entry point sets it. */
  const [settingsSection, setSettingsSection] = useState('appearance');
  const [settings, setSettings] = useState({
    theme: DEFAULT_THEME,
    autoUpdatesEnabled: true,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    printPageSize: 'Letter',
    printLandscape: false,
    editorWrap: false,
    editorTabSize: 4,
    editorLint: true,
    fonts: DEFAULT_FONTS,
    restoreSession: true,
    customTheme: null,
    shortcuts: DEFAULT_SHORTCUTS,
    // 1.14.0. Spell check is off by default on Linux, where Electron downloads its dictionaries
    // from Google's servers (see electron/spellcheck.cjs); remote images are opt-in everywhere.
    spellcheck: window.electronAPI?.platform === 'win32',
    remoteImages: false
  });
  const [activeShortcutRebind, setActiveShortcutRebind] = useState(null);

  /*
   * Refs, not state, for everything hot paths touch (see AI_CONTEXT.md §5a):
   *   progressBarRef / progressLabelRef   written by the ACTIVE MarkdownView on scroll frames
   *   cursorLabelRef                      written by the ACTIVE CodeEditor on cursor moves
   *   editorRefs                          docId → CodeEditor imperative handle (code tabs AND
   *                                       markdown tabs in edit mode)
   *   docsRef / activeIdRef / splitIdRef  current values for once-registered IPC callbacks and
   *   paneFocusRef                        keyboard closures, which must never go stale
   *
   * docsRef, activeIdRef, splitIdRef and paneFocusRef are written SYNCHRONOUSLY, in the same call
   * as the state update (commitDocs, activate, setSplit, focusPane), never mirrored by an effect
   * after React commits. The mirror lagged: two opens of one file inside a single commit (session
   * restore plus a launch argument) both saw the old tab list, and the file opened twice, then
   * three times on the next launch as the session saved both (H6).
   */
  const progressBarRef = useRef(null);
  const progressLabelRef = useRef(null);
  const cursorLabelRef = useRef(null);
  const editorRefs = useRef({});
  const pendingPrintRef = useRef(null);
  const docIdRef = useRef(1);
  const untitledCounterRef = useRef(1);
  const docsRef = useRef([]);
  const activeIdRef = useRef(null);
  const splitIdRef = useRef(null);
  const paneFocusRef = useRef(null);
  /*
   * The remote-images setting for renders started outside a render: IPC callbacks and the boot
   * sequence open documents, and must never see a stale value (written with the state, in
   * updateSetting and at boot).
   */
  const remoteImagesRef = useRef(false);
  /*
   * Whether the palette and Settings are open, and on which page: openPalette / openSettings run
   * from IPC, keys and the palette's own commands, where state can be a render behind (written by
   * those two and their close functions).
   */
  const showSettingsRef = useRef(false);
  const settingsSectionRef = useRef('appearance');
  const showPaletteRef = useRef(false);
  /** The boot effect has run (React's development double-run must not restore twice; L18). */
  const bootedRef = useRef(false);
  const sessionSaveTimerRef = useRef(null);
  /*
   * Who gets the focus at startup. Session restore replays every path from last time and each
   * replay opens a tab; without these, whichever restored tab happened to arrive LAST won, so
   * double-clicking a file to launch FATE left you looking at some other document. An explicit
   * open (association, dialog, drop, recents) sets explicitOpenRef and from then on restored tabs
   * never touch the selection; absent one, the tab that was active last time is reselected.
   */
  const explicitOpenRef = useRef(false);
  const restoreActiveKeyRef = useRef(null);
  /*
   * Hot exit (see hotExit.js):
   *   liveEditorsRef     docId → { handle, view }: unlike editorRefs, NOT cleared when React
   *                      detaches refs, so the crash flush can still read a buffer while the tree
   *                      is being torn down by an error
   *   pendingRestoresRef pathKey → backup waiting for its file's tab to open
   *   backupStateRef     backupId → what was last written ({ written, seen, pendingSince })
   *   backupQueueRef     backupId → promise chain, so a remove can never overtake a write
   *   quittingRef        set once the quit walk is done: no more backups, no unload guard
   */
  const liveEditorsRef = useRef(new Map());
  const pendingRestoresRef = useRef(new Map());
  const backupStateRef = useRef(new Map());
  const backupQueueRef = useRef(new Map());
  const quittingRef = useRef(false);
  const restoreStartedRef = useRef(false);
  /** The current render's operations, for listeners registered once (IPC, menu, keys, timers). */
  const opsRef = useRef(null);

  const activeDoc = docs.find((d) => d.id === activeId) || null;
  /* The doc commands act on (see the top of this component): the split pane's while it has focus. */
  const splitShown = splitId !== null && splitId !== activeId && !diffData;
  const focusedId = splitShown && paneFocusId === splitId ? splitId : activeId;
  const focusedDoc = focusedId === activeId ? activeDoc : docs.find((d) => d.id === focusedId) || activeDoc;

  /**
   * Change one setting. The updater only computes the new state; storing the value, retheming the
   * page and telling the main process all happen here, outside it (L18: updaters must be pure, and
   * React runs them twice in development, which doubled every store write and IPC call).
   */
  const updateSetting = (key, value) => {
    const api = window.electronAPI;
    if (api) api.store.set(key, value);
    if (key === 'theme') document.documentElement.setAttribute('data-theme', value);
    if (key === 'fonts') applyFonts(value);
    if (key === 'customTheme') applyCustomTheme(value);
    // Live, not at the next launch: main applies it to the session (see electron/spellcheck.cjs).
    if (key === 'spellcheck') api?.setSpellcheck?.(value)?.catch?.(() => {});
    if (key === 'remoteImages') {
      remoteImagesRef.current = value === true;
      rerenderForRemoteImages();
    }
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  /* ── Doc state ───────────────────────────────────────────────────────────────────────────── */

  /** The one way the tab list changes: state and docsRef move together (see the refs above). */
  const commitDocs = (next) => {
    const prev = docsRef.current;
    const value = typeof next === 'function' ? next(prev) : next;
    if (value === prev) return;
    docsRef.current = value;
    setDocs(value);
  };

  /** Merge `patch` (an object, or a function of the doc) into one doc. No-op when nothing changes. */
  const patchDoc = (id, patch) => {
    commitDocs((ds) => {
      let changed = false;
      const out = ds.map((d) => {
        if (d.id !== id) return d;
        const p = typeof patch === 'function' ? patch(d) : patch;
        if (Object.keys(p).every((k) => d[k] === p[k])) return d;
        changed = true;
        return finalizeDoc({ ...d, ...p });
      });
      return changed ? out : ds;
    });
  };

  const getDoc = (id) => docsRef.current.find((d) => d.id === id) || null;
  const findDocByPath = (p) => {
    const key = pathKey(p);
    return docsRef.current.find((d) => d.path && pathKey(d.path) === key) || null;
  };

  /**
   * Make `id` the active tab (null: the home screen). Its pane takes the focus role too, and a
   * diff on screen closes when the tab changes (L5): it compared what WAS showing. Activating the
   * doc that is in the split pane swaps the panes, so both stay on screen; it used to leave split
   * mode on with a single pane.
   */
  const activate = (id) => {
    if (id !== activeIdRef.current) setDiffData(null);
    if (id !== null && id === splitIdRef.current) setSplit(activeIdRef.current);
    activeIdRef.current = id;
    setActiveId(id);
    focusPane(id);
  };

  const setSplit = (id) => {
    splitIdRef.current = id;
    setSplitId(id);
  };

  /** A pane got focus (or a click): its doc is the one commands act on (L3). */
  const focusPane = (id) => {
    if (paneFocusRef.current === id) return;
    paneFocusRef.current = id;
    setPaneFocusId(id);
  };

  /** The focused doc's id, for handlers (the render-time twin is `focusedId` above). */
  const focusedDocId = () => {
    const split = splitIdRef.current;
    const active = activeIdRef.current;
    return split !== null && split !== active && !diffData && paneFocusRef.current === split ? split : active;
  };

  /**
   * Bring a doc forward, out from under any diff: the active tab's and the split pane's just take
   * the focus role (the right pane works without becoming active), anything else is activated.
   */
  const showDoc = (id) => {
    setDiffData(null);
    if (id !== null && (id === activeIdRef.current || id === splitIdRef.current)) focusPane(id);
    else activate(id);
  };

  /** focusin and clicks inside the panes: the pane they land in becomes the focused one. */
  const onPaneFocusEvent = (e) => {
    const pane = e.target instanceof Element ? e.target.closest('.doc-pane[data-doc-id]') : null;
    if (pane) focusPane(Number(pane.dataset.docId));
  };

  /** Does closing this tab lose anything? The live editor is the authority when one is mounted. */
  const isDocDirty = (doc) => {
    if (!doc) return false;
    const editor = editorRefs.current[doc.id];
    const textDirty = editor ? editor.isDirty() : !!doc.textDirty;
    return textDirty || formatChanged(doc);
  };

  /** Text content of a doc as it stands right now (live buffer if an editor is mounted). */
  const docText = (doc) => {
    const editor = editorRefs.current[doc.id];
    if (editor) return editor.getContent();
    if (doc.kind === 'markdown') return doc.source;
    return doc.codeContent;
  };

  /** The doc's baseline: the text last known to be on disk. */
  const docBaseline = (doc) => {
    const editor = editorRefs.current[doc.id];
    if (editor) return editor.getSavedContent();
    if (doc.kind === 'markdown') return doc.savedSource;
    return doc.savedContent ?? doc.codeContent;
  };

  /**
   * Ref callback for a doc's CodeEditor (code tab, or a Markdown tab's Edit mode). React calls
   * these with null and then the handle on every render (they are inline); only editorRefs
   * follows that churn. liveEditorsRef keeps the last handle until the tab closes or leaves the
   * editor, for the crash flush.
   */
  const editorRefFor = (docId) => (el) => {
    if (el) {
      editorRefs.current[docId] = el;
      const live = liveEditorsRef.current.get(docId);
      if (live?.handle === el) live.view = el.getView() ?? live.view;
      else liveEditorsRef.current.set(docId, { handle: el, view: el.getView() });
    } else if (editorRefs.current[docId]) {
      delete editorRefs.current[docId];
    }
  };

  /** The editor for this doc is going away for good (tab closing, or leaving the editor). */
  const forgetEditor = (docId) => {
    delete editorRefs.current[docId];
    liveEditorsRef.current.delete(docId);
  };

  /* ── Hot exit: backups of unsaved buffers ────────────────────────────────────────────────── */

  /**
   * Run backup IPC for one id strictly in order: a remove must never overtake its write.
   * Resolves true when the operation succeeded (main resolves { ok: false, error } on failure).
   */
  const queueBackupOp = (id, op) => {
    const prev = backupQueueRef.current.get(id) || Promise.resolve();
    const next = prev
      .then(op)
      .then((res) => {
        if (res && res.ok === false) throw new Error(res.error || res.code || 'failed');
        return true;
      })
      .catch((err) => {
        console.warn('Hot-exit backup failed:', err?.message || err);
        return false;
      });
    backupQueueRef.current.set(id, next);
    next.then(() => {
      if (backupQueueRef.current.get(id) === next) backupQueueRef.current.delete(id);
    });
    return next;
  };

  /** Delete a doc's backup, if one was ever written (or adopted from a restore). */
  const dropBackup = (doc) => {
    const id = doc?.backupId;
    if (!id || !backupStateRef.current.has(id)) return Promise.resolve();
    backupStateRef.current.delete(id);
    const api = window.electronAPI?.backups;
    if (!api?.remove) return Promise.resolve();
    return queueBackupOp(id, () => api.remove(id));
  };

  /** Delete a backup by id (one superseded or found clean during restore). */
  const dropBackupId = (id) => {
    backupStateRef.current.delete(id);
    const api = window.electronAPI?.backups;
    if (api?.remove) queueBackupOp(id, () => api.remove(id));
  };

  /** A restored tab adopts its backup's file: mark it written so it is replaced or removed later. */
  const adoptBackup = (id) => {
    backupStateRef.current.set(id, { written: ['restored'], seen: null, pendingSince: 0, retryAt: 0 });
  };

  /** Identity of everything a backup holds; any change means the backup is out of date. */
  const backupSignature = (doc, editor) => [
    editor ? editor.getDocSnapshot() : doc.kind === 'markdown' ? doc.source : doc.codeContent,
    editor ? editor.getSavedDoc() : doc.kind === 'markdown' ? doc.savedSource : doc.savedContent,
    doc.format, doc.name, doc.path, doc.kind, !!doc.editMode
  ];

  const writeBackup = (doc, editor) => {
    const api = window.electronAPI?.backups;
    const content = editor ? editor.getContent() : doc.kind === 'markdown' ? doc.source : doc.codeContent;
    const saved = doc.path ? docBaseline(doc) : null;
    const data = backupPayload(doc, content, saved);
    return queueBackupOp(doc.backupId, () => api.write(doc.backupId, data));
  };

  /**
   * Every BACKUP_TICK_MS: back up dirty tabs whose content moved and then held still for a tick
   * (or has waited BACKUP_MAX_WAIT_MS), and drop the backups of tabs that are clean again.
   * Comparing identities (CodeMirror's immutable docs, the source strings) keeps an idle tick
   * O(tabs); text is only serialised for a write.
   */
  const backupTick = () => {
    if (!window.electronAPI?.backups?.write || quittingRef.current) return;
    const now = nowMs();
    for (const doc of docsRef.current) {
      const editor = editorRefs.current[doc.id];
      const live = liveEditorsRef.current.get(doc.id);
      if (live && editor) live.view = editor.getView() ?? live.view;

      let st = backupStateRef.current.get(doc.backupId);
      if (!isDocDirty(doc)) {
        if (st) dropBackup(doc);
        continue;
      }
      if (!st) {
        st = { written: null, seen: null, pendingSince: 0, retryAt: 0 };
        backupStateRef.current.set(doc.backupId, st);
      }
      if (now < st.retryAt) continue;
      const sig = backupSignature(doc, editor);
      if (sameSignature(sig, st.written)) {
        st.seen = sig;
        st.pendingSince = 0;
        continue;
      }
      if (!st.pendingSince) st.pendingSince = now;
      const stable = sameSignature(sig, st.seen);
      st.seen = sig;
      if (!stable && now - st.pendingSince < BACKUP_MAX_WAIT_MS) continue;
      st.written = sig;
      st.pendingSince = 0;
      writeBackup(doc, editor).then((ok) => {
        // Not on disk after all: forget it was written, and try again in a while.
        if (!ok && st.written === sig) {
          st.written = null;
          st.retryAt = nowMs() + BACKUP_RETRY_MS;
        }
      });
    }
  };

  /**
   * Write every dirty tab's backup NOW (the error boundary's crash flush). Reads buffers through
   * liveEditorsRef, which survives React detaching the editors' refs. Resolves true when every
   * write landed (or nothing was dirty).
   */
  const flushBackupsNow = () => {
    const api = window.electronAPI?.backups;
    const dirty = docsRef.current.filter((d) => d.dirty);
    if (!dirty.length) return Promise.resolve(true);
    if (!api?.write) return Promise.resolve(false);
    return Promise.all(
      dirty.map((doc) => {
        const live = liveEditorsRef.current.get(doc.id);
        const view = live?.view ?? live?.handle?.getView?.() ?? null;
        const content = view ? view.state.doc.toString() : doc.kind === 'markdown' ? doc.source : doc.codeContent;
        let saved = null;
        if (doc.path) {
          saved = live ? live.handle.getSavedContent() : doc.kind === 'markdown' ? doc.savedSource : doc.savedContent ?? doc.codeContent;
        }
        return api.write(doc.backupId, backupPayload(doc, content, saved)).then(() => true, () => false);
      })
    ).then((results) => results.every(Boolean));
  };

  /* ── Opening ─────────────────────────────────────────────────────────────────────────────── */

  /**
   * renderFields with the current settings. Every Markdown render goes through here, so remote
   * images load in exactly the documents the setting allows (read from a ref: this runs from IPC
   * callbacks and the boot sequence too).
   */
  const renderDoc = (content, fPath) => renderFields(content, fPath, { remoteImages: remoteImagesRef.current });

  /**
   * Build a doc. `baseline` is the text on disk when it differs from `content` (restored
   * backups); `kind` is decided by the caller (name AND size, see kindForOpen). Its indentation
   * is detected here, once (M7): what the file type requires, else what the text itself does.
   */
  const createDoc = ({
    kind, name, path = null, content, baseline, format = null, savedFormat = null, untitled = false,
    editMode = false, backupId, plainText = false, notice = null, diskChange = null, diskDeleted = false
  }) => {
    const id = docIdRef.current++;
    const hasBaseline = typeof baseline === 'string';
    const common = {
      id, name, path: path || null, untitled, format, savedFormat,
      backupId: backupId || newBackupId(),
      textDirty: hasBaseline && baseline !== content,
      notice, diskChange, diskDeleted,
      indent: indentForDocument(name, content)
    };
    if (kind === 'markdown') {
      const { fields, failed } = renderDoc(content, path);
      if (failed) setStatusError(renderFailedMessage(name));
      return finalizeDoc({
        ...common, kind: 'markdown', source: content, savedSource: hasBaseline ? baseline : content, editMode, ...fields
      });
    }
    return finalizeDoc({
      ...common,
      kind: 'code',
      codeContent: content,
      savedContent: hasBaseline && baseline !== content ? baseline : undefined,
      langName: plainText ? 'Plain text' : detectLanguage(name, content)?.name ?? 'Plain text',
      plainText,
      largeFile: content.length > LARGE_FILE_LIMIT,
      follow: false
    });
  };

  /** A doc for a file just read from disk. Big Markdown opens as plain text, with a notice. */
  const docFromDisk = (content, name, fPath, format) => {
    const kind = kindForOpen(name, content.length);
    const tooBig = kind === 'code' && fileKindForName(name) === 'markdown';
    return createDoc({
      kind, name, path: fPath, content,
      format: format ?? (fPath ? null : UNTITLED_FORMAT),
      savedFormat: format ?? null,
      plainText: tooBig,
      notice: tooBig
        ? { text: `${name} is ${megabytes(content.length)} MB, so it opened as plain text.`, renderAction: true }
        : null
    });
  };

  /**
   * A doc rebuilt from a hot-exit backup of a file. `disk` is the file's text now (null when it
   * could not be read: `missing` says whether it is gone). The baseline is what is on disk NOW,
   * so the tab is dirty exactly when Save would change the file; if the file moved on since the
   * edits were made, the changed-on-disk bar says so.
   */
  const docFromBackup = (b, { name, path, disk, diskFormat, missing }) => {
    const kind = b.kind === 'markdown' && b.content.length <= MARKDOWN_RENDER_LIMIT ? 'markdown' : 'code';
    const known = typeof disk === 'string';
    adoptBackup(b.id);
    return createDoc({
      kind, name, path, content: b.content,
      baseline: known ? disk : missing ? '' : (b.savedContent ?? ''),
      format: b.format ?? diskFormat ?? null,
      savedFormat: known ? diskFormat ?? null : null,
      editMode: kind === 'markdown' && !!b.editMode,
      backupId: b.id,
      plainText: kind === 'code' && fileKindForName(name) === 'markdown',
      diskChange: known && typeof b.savedContent === 'string' && b.savedContent !== disk
        ? { content: disk, format: diskFormat ?? null }
        : null,
      diskDeleted: !!missing
    });
  };

  /**
   * A restored backup takes the focus when nothing else has a claim to it: no explicit open, no
   * active tab remembered by the session, nothing selected yet. Unsaved work you were in the
   * middle of beats the home screen.
   */
  const focusRestored = (id) => {
    if (!explicitOpenRef.current && restoreActiveKeyRef.current === null && activeIdRef.current === null) {
      activate(id);
    }
  };

  /** Does a backup hold anything the file on disk doesn't? */
  const backupDiffersFromDisk = (b, disk, diskFormat) =>
    b.content !== disk || (!!b.format && !!diskFormat && formatChanged({ format: b.format, savedFormat: diskFormat }));

  /**
   * A backup for a file whose tab already exists (it opened before the backups were listed).
   * A clean tab takes the backed-up text as a dirty buffer; a tab with edits of its own keeps
   * them, and the backup becomes a separate recovered copy rather than being lost or merged.
   */
  const applyBackupToOpenDoc = (doc, b, disk, diskFormat) => {
    if (typeof disk === 'string' && !backupDiffersFromDisk(b, disk, diskFormat)) {
      dropBackupId(b.id);
      applyDiskContent(doc, disk, diskFormat);
      return;
    }
    if (isDocDirty(doc)) {
      restoreUntitled({ ...b, name: `Recovered ${b.name || baseName(b.path)}`, path: null });
      return;
    }
    const baseline = typeof disk === 'string' ? disk : docBaseline(doc);
    const editor = editorRefs.current[doc.id];
    if (editor) editor.replaceContent(b.content, baseline);
    let rendered = {};
    if (doc.kind === 'markdown' && !doc.editMode) {
      const { fields, failed } = renderDoc(b.content, doc.path);
      if (failed) setStatusError(renderFailedMessage(doc.name));
      rendered = fields;
    }
    dropBackup(doc);
    adoptBackup(b.id);
    patchDoc(doc.id, {
      backupId: b.id,
      format: b.format ?? doc.format,
      textDirty: b.content !== baseline,
      ...(doc.kind === 'markdown' ? { source: b.content, savedSource: baseline, ...rendered } : {}),
      ...(doc.kind === 'code' && !editor ? { codeContent: b.content, savedContent: baseline } : {}),
      diskChange: typeof disk === 'string' && typeof b.savedContent === 'string' && b.savedContent !== disk
        ? { content: disk, format: diskFormat ?? null }
        : null
    });
  };

  /**
   * Route an opened file into a tab. All open paths funnel through here: dialog, recents, drag &
   * drop, file association, second instance, session restore. A path that is already open just
   * activates its existing tab instead of duplicating it, and takes the disk text only if the tab
   * has no unsaved changes; otherwise the changed-on-disk bar offers the choice (C3).
   */
  const openDocument = (content, name, fPath, meta = {}) => {
    const key = fPath ? pathKey(fPath) : null;
    const format = meta.format ?? null;

    /** Should this open take the user to the tab? Restored tabs only do so if they were active. */
    const shouldFocus = () => {
      if (!meta.fromRestore) {
        explicitOpenRef.current = true;
        return true;
      }
      return !explicitOpenRef.current && !!key && key === restoreActiveKeyRef.current;
    };

    const restore = key ? pendingRestoresRef.current.get(key) : null;
    if (restore) pendingRestoresRef.current.delete(key);

    const existing = key ? findDocByPath(fPath) : null;
    if (existing) {
      if (shouldFocus()) activate(existing.id);
      if (restore) applyBackupToOpenDoc(existing, restore, content, format);
      else applyDiskContent(existing, content, format);
      setIsLoading(false);
      return;
    }

    let doc;
    const restoring = !!restore && backupDiffersFromDisk(restore, content, format);
    if (restoring) {
      doc = docFromBackup(restore, { name, path: fPath, disk: content, diskFormat: format, missing: false });
    } else {
      if (restore) dropBackupId(restore.id); // nothing in it that isn't on disk already
      doc = docFromDisk(content, name, fPath, format);
    }
    commitDocs((ds) => [...ds, doc]);
    if (shouldFocus()) activate(doc.id);
    else if (restoring) focusRestored(doc.id);
    setIsLoading(false);
  };

  /** A fresh, empty, unsaved buffer. Saving offers every supported format (Save As). */
  const newFile = () => {
    const n = untitledCounterRef.current++;
    const doc = createDoc({
      kind: 'code', name: `Untitled-${n}`, content: '', baseline: '', untitled: true, format: UNTITLED_FORMAT
    });
    commitDocs((ds) => [...ds, doc]);
    activate(doc.id);
  };

  /**
   * An Untitled tab from a backup (or a recovered copy that has nowhere else to go). `focus`: it
   * was the active tab when the last session ended, and nothing was opened explicitly since.
   */
  const restoreUntitled = (b, { focus = false } = {}) => {
    const n = untitledNumber(b.name);
    if (n >= untitledCounterRef.current) untitledCounterRef.current = n + 1;
    const kind = b.kind === 'markdown' && b.content.length <= MARKDOWN_RENDER_LIMIT ? 'markdown' : 'code';
    adoptBackup(b.id);
    const doc = createDoc({
      kind,
      name: b.name || `Untitled-${untitledCounterRef.current++}`,
      content: b.content,
      baseline: '',
      untitled: true,
      format: b.format ?? UNTITLED_FORMAT,
      editMode: kind === 'markdown' && !!b.editMode,
      backupId: b.id
    });
    commitDocs((ds) => [...ds, doc]);
    if (focus && !explicitOpenRef.current) activate(doc.id);
    else focusRestored(doc.id);
  };

  /**
   * A path-backed backup whose file never opened: gone from disk ('missing'), or it failed to
   * open or took too long ('unopened'). The text comes back anyway, as a tab on that path. Main
   * never opened the path, so Save goes through Save As (see saveDoc's NOT_OPEN fallback).
   */
  const restoreWithoutFile = (key, reason) => {
    const b = pendingRestoresRef.current.get(key);
    if (!b) return;
    pendingRestoresRef.current.delete(key);
    const existing = findDocByPath(b.path);
    if (existing) {
      applyBackupToOpenDoc(existing, b, null, null);
      return;
    }
    const doc = docFromBackup(b, {
      name: b.name || baseName(b.path), path: b.path, disk: null, diskFormat: null, missing: reason === 'missing'
    });
    commitDocs((ds) => [...ds, doc]);
    focusRestored(doc.id);
  };

  /**
   * Startup: last session's tabs (when that setting is on) and hot-exit backups (always: they only
   * exist after a session that did not end cleanly). Backups of files are applied as each file's
   * tab opens through the normal open path; Untitled ones become tabs straight away.
   */
  const restoreSession = (session, backups) => {
    if (restoreStartedRef.current) return; // once per page, whatever calls it (see bootedRef)
    restoreStartedRef.current = true;
    const api = window.electronAPI;
    const hasSession = !!session && Array.isArray(session.paths);
    // Known before anything is restored, so restored tabs never take the focus from it.
    if (hasSession) restoreActiveKeyRef.current = session.active ? pathKey(session.active) : null;

    const plan = planRestore(backups, pathKey);
    for (const id of plan.drop) dropBackupId(id);
    for (const [key, b] of plan.byPath) pendingRestoresRef.current.set(key, b);
    for (const b of plan.untitled) {
      if (b.content) restoreUntitled(b, { focus: !!session?.activeBackup && b.id === session.activeBackup });
      else dropBackupId(b.id); // an empty Untitled buffer: nothing to bring back
    }

    const opening = new Set();
    const openForRestore = (p) => {
      const key = pathKey(p);
      if (opening.has(key)) return;
      opening.add(key);
      api
        .openRecentFile(p, { fromRestore: true })
        .then((res) => {
          // 'missing': the file is gone. 'error': it would not open, and main said why.
          if (!res?.ok) restoreWithoutFile(key, res?.reason === 'missing' ? 'missing' : 'unopened');
        })
        .catch(() => restoreWithoutFile(key, 'unopened'));
    };

    /*
     * Session restore: reopen last session's saved-to-disk tabs (untitled buffers come back
     * through their backups instead). Runs through the main process like every open, so watchers,
     * recents and same-path dedupe (against e.g. a file-association argv arriving in parallel) all
     * apply. Paths are de-duplicated here too, in case an older version saved a doubled list.
     */
    if (hasSession) {
      const paths = uniqueBy(session.paths.filter((p) => typeof p === 'string' && p), pathKey);
      for (const p of paths) openForRestore(p);
    }
    for (const b of plan.byPath.values()) openForRestore(b.path);

    if (plan.byPath.size) {
      setTimeout(() => {
        for (const key of [...pendingRestoresRef.current.keys()]) restoreWithoutFile(key, 'unopened');
      }, RESTORE_TIMEOUT_MS);
    }
  };

  /* ── Disk changes ────────────────────────────────────────────────────────────────────────── */

  /**
   * The disk's format is now `format`: record it, and make it the tab's too unless the user
   * picked a different one for this tab (an EOL or encoding switch not yet saved).
   */
  const followDiskFormat = (doc, format) => {
    if (!format) return {};
    return formatChanged(doc) ? { savedFormat: format } : { savedFormat: format, format };
  };

  /** Replace a doc's text with `content` from disk: it becomes the baseline, the tab is clean. */
  const reloadDoc = (doc, content, format) => {
    const editor = editorRefs.current[doc.id];
    if (editor) editor.replaceContent(content);
    const patch = {
      textDirty: false,
      diskChange: null,
      diskDeleted: false,
      savedFormat: format ?? doc.savedFormat,
      format: format ?? doc.savedFormat ?? doc.format
    };
    if (doc.kind === 'markdown') {
      patch.source = content;
      patch.savedSource = content;
      if (!doc.editMode) {
        const { fields, failed } = renderDoc(content, doc.path);
        if (failed) setStatusError(renderFailedMessage(doc.name));
        Object.assign(patch, fields);
      }
    } else if (!editor) {
      patch.codeContent = content;
      patch.savedContent = undefined;
    }
    patchDoc(doc.id, patch);
    if (doc.follow) editor?.scrollToEnd();
    dropBackup(doc);
  };

  /**
   * New text for a doc's file arrived from disk: a watch event, or the path opened again. A clean
   * tab reloads (caret and folds stay put; see CodeEditor.replaceContent). A tab with unsaved
   * changes KEEPS them, whatever mode it is in, and shows the changed-on-disk bar (C3: a Markdown
   * tab in Reading view used to be overwritten here, dirty dot and all, and Save then wrote the
   * disk text back).
   */
  const applyDiskContent = (doc, content, format) => {
    const editor = editorRefs.current[doc.id];
    if (content === docBaseline(doc)) {
      /*
       * Identical to what we already know is on disk: NOT a change. Windows fires watch events
       * for more than real writes (Defender scans, indexing touch the file); a re-render on those
       * visibly resets post-render DOM work like mermaid diagrams for no reason. The format may
       * still have moved on its own (another tool converted CRLF to LF): that is a format update,
       * and the tab follows it unless the user switched the tab's format themselves.
       */
      patchDoc(doc.id, { diskDeleted: false, diskChange: null, ...followDiskFormat(doc, format) });
      return;
    }
    if (content === docText(doc)) {
      // The buffer already holds exactly what is on disk now (saved elsewhere, edits undone).
      if (editor) editor.setBaseline(content);
      patchDoc(doc.id, {
        ...(doc.kind === 'markdown' ? { savedSource: content } : editor ? {} : { savedContent: undefined, codeContent: content }),
        textDirty: editor ? editor.isDirty() : false,
        ...followDiskFormat(doc, format),
        diskChange: null,
        diskDeleted: false
      });
      return;
    }
    if (!isDocDirty(doc)) {
      reloadDoc(doc, content, format);
      return;
    }
    patchDoc(doc.id, { diskChange: { content, format: format ?? null }, diskDeleted: false });
  };

  /** Live-reload on external disk change, routed to the owning tab by path. */
  const onDiskChange = (content, changedPath, meta = {}) => {
    const doc = findDocByPath(changedPath);
    if (doc) applyDiskContent(doc, content, meta.format ?? null);
  };

  /**
   * The file behind a tab is gone. Its text now exists only here, so the baseline becomes empty
   * (the tab is dirty unless it is empty too, and closing it prompts) and a bar says what
   * happened. Saving writes the file again.
   */
  const markDeleted = (deletedPath) => {
    const doc = findDocByPath(deletedPath);
    if (!doc) return;
    const editor = editorRefs.current[doc.id];
    if (editor) editor.setBaseline('');
    patchDoc(doc.id, {
      diskDeleted: true,
      diskChange: null,
      ...(doc.kind === 'markdown' ? { savedSource: '' } : editor ? {} : { savedContent: '' }),
      textDirty: editor ? editor.isDirty() : docText(doc) !== ''
    });
  };

  /** Changed-on-disk bar → Reload: take the disk version, discarding the tab's unsaved edits. */
  const reloadFromDisk = (id) => {
    const doc = getDoc(id);
    if (doc?.diskChange) reloadDoc(doc, doc.diskChange.content, doc.diskChange.format);
  };

  /**
   * Changed-on-disk bar → Keep mine. The disk text becomes the baseline, so the tab stays dirty
   * for exactly as long as it differs from the file, and Save overwrites the file with this tab.
   */
  const keepMine = (id) => {
    const doc = getDoc(id);
    if (!doc?.diskChange) return;
    const { content, format } = doc.diskChange;
    const editor = editorRefs.current[id];
    if (editor) editor.setBaseline(content);
    patchDoc(id, {
      diskChange: null,
      ...followDiskFormat(doc, format),
      ...(doc.kind === 'markdown' ? { savedSource: content } : editor ? {} : { savedContent: content }),
      textDirty: editor ? editor.isDirty() : docText(doc) !== content
    });
  };

  /** Changed-on-disk bar → Compare: the diff view, the file on disk against this tab. */
  const compareWithDisk = (id) => {
    const doc = getDoc(id);
    if (!doc?.diskChange) return;
    setDiffData({
      leftText: doc.diskChange.content,
      rightText: docText(doc),
      leftName: `${doc.name} (on disk)`,
      rightName: `${doc.name} (your version)`,
      leftFileName: doc.name,
      rightFileName: doc.name,
      docIds: [doc.id]
    });
  };

  /* ── File format: line endings and encoding ──────────────────────────────────────────────── */

  const toggleEol = (id) => {
    const doc = getDoc(id);
    if (!doc?.format) return;
    patchDoc(id, { format: { ...doc.format, eol: toggledEol(doc.format.eol) } });
  };

  /** "Save with encoding…": applies on the next save; until then the tab is dirty. */
  const setEncoding = (id, choice) => {
    const doc = getDoc(id);
    if (!doc?.format) return;
    patchDoc(id, { format: { ...doc.format, encoding: choice.encoding, bom: choice.bom } });
  };

  /** "Reopen with encoding…": reread the file decoded another way. Clean tabs only. */
  const reopenWithEncoding = async (id, encoding) => {
    const doc = getDoc(id);
    const api = window.electronAPI;
    if (!doc?.path || isDocDirty(doc) || !api?.reopenWithEncoding) return;
    let res;
    try {
      res = await api.reopenWithEncoding(doc.path, encoding);
    } catch (err) {
      res = { ok: false, error: err?.message };
    }
    if (!res?.ok || typeof res.content !== 'string') {
      setStatusError(res?.error || `Couldn't reopen ${doc.name}`);
      return;
    }
    const latest = getDoc(id);
    if (!latest || isDocDirty(latest)) return; // edited while the file was read: leave it be
    reloadDoc(latest, res.content, res.format ?? null);
  };

  /* ── Large files, logs and Markdown in the editor ────────────────────────────────────────── */

  /** Follow: while on, each reload from disk (clean tab) scrolls to the end, like `tail -f`. */
  const toggleFollow = (id) => {
    const doc = getDoc(id);
    if (!doc || doc.kind !== 'code') return;
    patchDoc(id, { follow: !doc.follow });
    if (!doc.follow) editorRefs.current[id]?.scrollToEnd();
  };

  /**
   * "Render as Markdown": turn a code tab that could be Markdown (.txt, extensionless, or a .md
   * too big to render on open) into a Markdown reading tab, unsaved changes and all. Rendering
   * goes through the same safety net as every other render.
   */
  const renderAsMarkdown = (id) => {
    const doc = getDoc(id);
    if (!doc || doc.kind !== 'code' || !couldBeMarkdown(doc.name)) return;
    const editor = editorRefs.current[id];
    const text = editor ? editor.getContent() : doc.codeContent;
    const saved = docBaseline(doc);
    const textDirty = editor ? editor.isDirty() : !!doc.textDirty;
    const { fields, failed } = renderDoc(text, doc.path);
    if (failed) setStatusError(renderFailedMessage(doc.name));
    forgetEditor(id);
    patchDoc(id, {
      kind: 'markdown', source: text, savedSource: saved, textDirty, editMode: false, ...fields,
      notice: null, codeContent: undefined, savedContent: undefined, langName: undefined,
      plainText: false, largeFile: false, follow: false
    });
  };

  /* ── Closing / navigation ────────────────────────────────────────────────────────────────── */

  /**
   * Take a tab out NOW: no prompt (callers asked already). `unwatch: false` when another tab owns
   * the path from here on (Save As onto it), so its watcher must stay.
   */
  const removeDocNow = (docId, { unwatch = true } = {}) => {
    const doc = getDoc(docId);
    if (!doc) return;
    if (unwatch && doc.path && window.electronAPI) window.electronAPI.closeFile(doc.path);
    forgetEditor(docId);
    dropBackup(doc);

    const ds = docsRef.current;
    const idx = ds.findIndex((d) => d.id === docId);
    const next = ds.filter((d) => d.id !== docId);
    if (splitIdRef.current === docId) {
      setSplit(null);
      setDiffData(null);
    }
    // A diff of this tab (Compare, Diff unsaved changes) has nothing left to show.
    setDiffData((dd) => (dd?.docIds?.includes(docId) ? null : dd));
    if (activeIdRef.current === docId) {
      const nextId = next.length ? next[Math.min(idx, next.length - 1)].id : null;
      // The split pane's doc taking over the active slot: one doc, so no split.
      if (nextId !== null && nextId === splitIdRef.current) setSplit(null);
      activate(nextId);
    }
    commitDocs(next);
  };

  /**
   * Close a tab. Unsaved changes get Save / Don't save / Cancel (L15; it used to be Discard or
   * Cancel, with no way to keep the work short of cancelling and saving by hand). Resolves true
   * when the tab closed.
   */
  const closeDoc = async (docId) => {
    const doc = getDoc(docId);
    if (!doc) return false;

    if (isDocDirty(doc)) {
      const api = window.electronAPI;
      const answer = api?.confirmSaveOnClose
        ? await api.confirmSaveOnClose(doc.name).catch(() => 'cancel')
        : window.confirm('Discard unsaved changes?')
          ? 'discard'
          : 'cancel';
      if (answer === 'cancel') return false;
      if (answer === 'save' && !(await saveDoc(docId))) return false;
    }

    removeDocNow(docId);
    return true;
  };

  /** Close several tabs in order, stopping at the first one the user keeps. */
  const closeMany = async (ids) => {
    for (const id of ids) {
      if (!(await closeDoc(id))) return false;
    }
    return true;
  };

  /** Cycle the active tab by offset. From the home screen, enter the strip at either end. */
  const cycleTab = (dir) => {
    const ds = docsRef.current;
    if (ds.length === 0) return;
    const idx = ds.findIndex((d) => d.id === activeIdRef.current);
    if (idx === -1) {
      activate(dir > 0 ? ds[0].id : ds[ds.length - 1].id);
    } else {
      activate(ds[(idx + dir + ds.length) % ds.length].id);
    }
  };

  /**
   * A tab's right-click: the native menu (main builds it) picks the action, the renderer does it.
   * Closing goes through closeDoc, so every dirty tab still gets its prompt.
   */
  const openTabMenu = async (e, doc) => {
    e.preventDefault();
    const api = window.electronAPI;
    if (!api?.showTabContextMenu) return;
    let action;
    try {
      action = await api.showTabContextMenu({ path: doc.path || null, name: doc.name });
    } catch {
      return;
    }
    const ids = docsRef.current.map((d) => d.id);
    const idx = ids.indexOf(doc.id);
    if (idx === -1) return;
    const current = getDoc(doc.id);
    switch (action) {
      case 'copyPath':
        if (current?.path) {
          navigator.clipboard.writeText(current.path).catch(() => setStatusError("Couldn't copy the path"));
        }
        break;
      case 'reveal':
        // Main refuses a file that has gone (or isn't open), and says why: show it.
        if (current?.path) {
          const failed = (error) => setStatusError(error || `Couldn't show ${current.name} in its folder`);
          Promise.resolve(api.showItemInFolder?.(current.path))
            .then((res) => {
              if (res && res.ok === false) failed(res.error);
            })
            .catch((err) => failed(err?.message));
        }
        break;
      case 'close':
        closeDoc(doc.id);
        break;
      case 'closeOthers':
        closeMany(ids.filter((id) => id !== doc.id));
        break;
      case 'closeRight':
        closeMany(ids.slice(idx + 1));
        break;
      default:
        break;
    }
  };

  /* ── Recents / default-app plumbing ──────────────────────────────────────────────────────── */

  const refreshRecentFiles = useCallback(() => {
    if (!window.electronAPI?.getRecentFiles) return;
    window.electronAPI.getRecentFiles().then(setRecentFiles).catch(() => {});
  }, []);

  const refreshDefaultAppStatus = useCallback(() => {
    if (!window.electronAPI?.getDefaultAppStatus) return;
    window.electronAPI.getDefaultAppStatus().then(setDefaultAppStatus).catch(() => {});
  }, []);

  const requestDefaultApp = useCallback(() => {
    if (!window.electronAPI?.requestDefaultApp) return;
    setStatusError('');
    window.electronAPI
      .requestDefaultApp()
      .then((res) => {
        if (res && res.ok === false) setStatusError(res.error || 'Could not open Windows Settings');
      })
      .catch((err) => setStatusError(err?.message || 'Could not open Windows Settings'));
  }, []);

  /* ── Printing ────────────────────────────────────────────────────────────────────────────── */

  const executePrintJob = useCallback((invoke, label, docName) => {
    setIsPrinting(true);
    setStatusError('');
    invoke(docName || 'Document')
      .then((res) => {
        if (res && res.ok === false && !res.canceled) setStatusError(res.error || `${label} failed`);
      })
      .catch((err) => setStatusError(err?.message || `${label} failed`))
      .finally(() => {
        setIsPrinting(false);
        setPrintSnapshot(null);
      });
  }, []);

  const runPrintJob = (invoke, label) => {
    if (typeof invoke !== 'function' || isPrinting) return;
    const doc = getDoc(focusedDocId());
    if (!doc) return;

    /*
     * Anything currently backed by a live CodeMirror (code tabs, markdown in edit mode) prints
     * from a snapshot: the editor virtualises long documents, so printing its DOM would emit one
     * truncated page. The snapshot is display:none on screen and becomes the whole document under
     * `@media print`; the job runs after React commits it (effect below).
     *
     * A Markdown tab in Edit mode prints RENDERED, exactly as Reading view would (L17): the
     * snapshot is the current buffer through the same renderer, not its source.
     *
     * The focused split pane prints instead of the active tab (L3). The print stylesheet prints
     * the active pane only, so while the snapshot names the split pane's doc, `.doc-panes` swaps
     * the two (see `print-right` in App.css); a reading view there waits for that commit too.
     */
    const editor = editorRefs.current[doc.id];
    let snapshot = null;
    if (editor && doc.kind === 'markdown') {
      const { fields, failed } = renderDoc(editor.getContent(), doc.path);
      if (failed) setStatusError(renderFailedMessage(doc.name));
      snapshot = { docId: doc.id, kind: 'markdown', markup: { __html: fields.html } };
    } else if (editor) {
      snapshot = { docId: doc.id, kind: 'code', text: editor.getContent() };
    } else if (doc.id !== activeIdRef.current) {
      snapshot = { docId: doc.id, kind: 'view' };
    }
    if (snapshot) {
      pendingPrintRef.current = () => executePrintJob(invoke, label, doc.name);
      setPrintSnapshot(snapshot);
      return;
    }

    executePrintJob(invoke, label, doc.name);
  };

  /* Runs the deferred snapshot-print job once the snapshot has committed to the DOM. */
  useEffect(() => {
    if (printSnapshot && pendingPrintRef.current) {
      const job = pendingPrintRef.current;
      pendingPrintRef.current = null;
      job();
    }
  }, [printSnapshot]);

  const openPrintPreview = () => runPrintJob(window.electronAPI?.printPreview, 'Preview');
  const exportPdf = () => runPrintJob(window.electronAPI?.exportPdf, 'Export');

  /* ── Saving ──────────────────────────────────────────────────────────────────────────────── */

  /**
   * A save landed: `content` (as read from `snapshot`, when an editor supplied one) is on disk in
   * `format`. The baseline moves to exactly that snapshot, so anything typed while the write was
   * in flight stays dirty (M4).
   */
  const markDocSaved = (id, { content, snapshot, editor, format }) => {
    const latest = getDoc(id);
    if (!latest) return; // closed while saving
    const ed = editorRefs.current[id];
    if (ed) {
      if (ed === editor && snapshot) ed.markSaved(snapshot);
      else ed.setBaseline(content);
    }
    patchDoc(id, {
      textDirty: ed ? ed.isDirty() : latest.kind === 'markdown' ? latest.source !== content : false,
      format: format ?? latest.format,
      savedFormat: format ?? latest.savedFormat,
      diskChange: null,
      diskDeleted: false,
      ...(latest.kind === 'markdown' ? { savedSource: content } : {}),
      ...(latest.kind === 'code' && !ed ? { savedContent: undefined, codeContent: content } : {})
    });
    const after = getDoc(id);
    if (after && !isDocDirty(after)) dropBackup(after);
  };

  /**
   * Save As landed on `res.filePath`. If that file was open in ANOTHER tab, that tab is stale:
   * a clean one just closes, but one with unsaved changes asks first (L14; they used to vanish
   * with it). The OS dialog already confirmed overwriting the file, and saveFileAs writes before
   * it returns, so this is the earliest point the renderer can ask. Keeping the changes turns
   * that tab into an unsaved copy rather than losing them.
   */
  const adoptSavedAsPath = async (id, res, content) => {
    const other = docsRef.current.find((d) => d.id !== id && d.path && pathKey(d.path) === pathKey(res.filePath));
    if (other) {
      let discard = !isDocDirty(other);
      if (!discard) {
        activate(other.id);
        discard = await window.electronAPI
          .confirmDiscard(`${other.name} is also open in another tab with unsaved changes, and Save As just replaced the file. Discard those changes?`)
          .catch(() => false);
        activate(id);
      }
      if (discard) removeDocNow(other.id, { unwatch: false });
      else detachDoc(other.id);
    }

    const latest = getDoc(id);
    if (!latest) return;
    const patch = { name: res.name, path: res.filePath, untitled: false, diskDeleted: false, diskChange: null };
    // Saved as a Makefile or a Go file: those indent with tabs from here on (M7).
    if (requiresTabs(res.name) && !latest.indent?.useTabs) patch.indent = { ...latest.indent, useTabs: true };
    if (latest.kind === 'code') {
      patch.langName = latest.plainText ? 'Plain text' : detectLanguage(res.name, content)?.name ?? 'Plain text';
    } else if (!latest.editMode) {
      // Relative image paths resolve against the new folder.
      const { fields } = renderDoc(latest.source, res.filePath);
      Object.assign(patch, fields);
    }
    patchDoc(id, patch);
    // New extension may mean a new language, so retune the live editor without a remount.
    editorRefs.current[id]?.setLanguage(res.name);
  };

  /** Turn a tab into an unsaved copy with no file (Save As took its file over). */
  const detachDoc = (id) => {
    const doc = getDoc(id);
    if (!doc) return;
    const editor = editorRefs.current[id];
    if (editor) editor.setBaseline('');
    patchDoc(id, {
      name: `Copy of ${doc.name}`,
      path: null,
      untitled: true,
      savedFormat: null,
      diskChange: null,
      diskDeleted: false,
      ...(doc.kind === 'markdown' ? { savedSource: '' } : editor ? {} : { savedContent: '' }),
      textDirty: editor ? editor.isDirty() : docText(doc) !== ''
    });
    setStatusError(`The other ${doc.name} tab is now an unsaved copy`);
  };

  /**
   * Save a tab (the focused one by default). Handles all three shapes: code tabs, markdown tabs
   * (edit mode saves the buffer; view mode saves the last known source), and untitled buffers
   * (always Save As, offering every supported format). `forceAs` is the Save As action. The tab's
   * `format` rides along, and the format main reports having written becomes the tab's.
   *
   * The tab is only marked clean AFTER the write succeeds; a failed save leaves the guards armed.
   * Resolves TRUE only when the file actually reached disk; the quit walk relies on that to stop
   * dead when a Save As is cancelled rather than closing over the edits it just offered to keep.
   */
  const saveDoc = async (docId, { forceAs = false } = {}) => {
    const id = typeof docId === 'number' ? docId : focusedDocId();
    const doc = getDoc(id);
    if (!doc || !window.electronAPI) return false;

    // Snapshot first: the text and the CodeMirror doc it came from, taken together (M4).
    const editor = editorRefs.current[id];
    const snapshot = editor ? editor.getDocSnapshot() : null;
    const content = snapshot ? snapshot.toString() : doc.kind === 'markdown' ? doc.source : null;
    if (content === null) return false;
    /*
     * Nothing to save writes nothing. Saving a clean tab used to rewrite its file anyway, and a file
     * with mixed line endings came back normalised to its majority ending: changed on disk by a
     * Ctrl+S that changed nothing. A deleted file (Save recreates it) or one changed on disk (Save
     * keeps your version) still saves.
     */
    if (!forceAs && doc.path && !doc.untitled && !doc.diskDeleted && !doc.diskChange && !isDocDirty(doc)) return true;
    const format = doc.format ?? undefined;

    setStatusError('');
    try {
      let res;
      if (doc.path && !forceAs) {
        res = await window.electronAPI.saveFile(doc.path, content, format);
        /*
         * Main only saves to paths it has open (opened by any route, or chosen in Save As). A tab
         * restored from a backup whose file was gone, or would not reopen, has a path main never
         * opened: it gets Save As, which is also how that file comes back into existence.
         */
        if (res?.code === 'NOT_OPEN') {
          res = await window.electronAPI.saveFileAs(suggestedSaveName(doc), content, null, format);
          if (res?.ok) await adoptSavedAsPath(id, res, content);
        }
      } else {
        res = await window.electronAPI.saveFileAs(suggestedSaveName(doc), content, doc.path, format);
        if (res?.ok) await adoptSavedAsPath(id, res, content);
      }

      if (res?.ok) {
        markDocSaved(id, { content, snapshot, editor, format: res.format ?? format ?? null });
        return true;
      }
      if (res?.code === 'UNENCODABLE') {
        // A Windows-1252 save of text it can't store. main's message suggests UTF-8.
        setStatusError(res.error || `${doc.name} has characters Windows-1252 can't store. Save it as UTF-8 instead.`);
      } else if (!res?.canceled) {
        setStatusError(res?.error || 'Save failed');
      }
      return false;
    } catch (err) {
      setStatusError(err?.message || 'Save failed');
      return false;
    }
  };

  /*
   * Quitting with unsaved work. The main process vetoes its own close and hands the flow here,
   * because it cannot save: the buffers live in CodeMirror. Each dirty tab is selected (so the
   * user can see what they are being asked about) and offered Save / Don't save / Cancel; Cancel,
   * or a save that does not reach disk, calls the whole quit off.
   *
   * Once the walk completes, the backups of the tabs the user chose not to save are deleted (a
   * clean exit leaves none behind) and the unload guard stands down, so the window can go. If it
   * is somehow still here ten seconds later, the close did not happen: backups resume.
   */
  const handleQuitRequest = async () => {
    const api = window.electronAPI;
    const discarded = [];
    for (const { id } of [...docsRef.current]) {
      const doc = getDoc(id);
      if (!doc || !isDocDirty(doc)) continue;
      activate(doc.id);
      const answer = await api.confirmSaveOnClose(doc.name).catch(() => 'cancel');
      if (answer === 'cancel') {
        api.confirmedClose(false);
        return;
      }
      if (answer === 'save') {
        if (!(await saveDoc(doc.id))) {
          api.confirmedClose(false);
          return;
        }
      } else {
        discarded.push(getDoc(doc.id) || doc);
      }
    }
    quittingRef.current = true;
    await Promise.race([
      Promise.all(discarded.map((d) => dropBackup(d))),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    api.confirmedClose(true);
    setTimeout(() => {
      quittingRef.current = false;
    }, 10000);
  };

  /** Mirror an editor's dirty flag into the doc list (title + guards follow via the sync effect). */
  const handleDirtyChange = (docId, textDirty) => {
    const doc = getDoc(docId);
    if (!doc || !!doc.textDirty === textDirty) return;
    patchDoc(docId, { textDirty });
    const after = getDoc(docId);
    if (after && !isDocDirty(after)) dropBackup(after); // clean again: nothing to keep
  };

  /* ── Indentation (M7) ────────────────────────────────────────────────────────────────────── */

  /** The indentation a doc's editor uses: its own, completed from the "Indent size" setting. */
  const indentOf = (d) => effectiveIndent(d?.indent, settings.editorTabSize);

  /** The status bar's indentation menu: this doc from now on. Nothing is re-indented. */
  const setDocIndent = (id, indent) => {
    if (!getDoc(id)) return;
    patchDoc(id, { indent: { useTabs: !!indent.useTabs, size: indent.size } });
  };

  /* ── Remote images ───────────────────────────────────────────────────────────────────────── */

  /**
   * The remote-images setting changed: render the reading views again, with or without them.
   * Only documents that HAVE remote images can come out different, so only those re-render, and
   * not in Edit mode: leaving Edit mode renders afresh anyway, and the edit preview follows the
   * setting itself (MarkdownEditView's remoteImagesAllowed).
   */
  const rerenderForRemoteImages = () => {
    for (const doc of docsRef.current) {
      if (doc.kind !== 'markdown' || doc.editMode || !doc.remoteImageCount) continue;
      const { fields, failed } = renderDoc(doc.source, doc.path);
      if (failed) setStatusError(renderFailedMessage(doc.name));
      patchDoc(doc.id, fields);
    }
  };

  /* ── Markdown edit mode ──────────────────────────────────────────────────────────────────── */

  /**
   * Leaving Edit mode hands the buffer to the reading view along with its baseline and dirty
   * state, so the tab is exactly as unsaved as it was (C4), and coming back into Edit mode
   * measures dirtiness against `savedSource`, not against whatever text the tab holds.
   */
  const toggleMarkdownEdit = (docId) => {
    const id = typeof docId === 'number' ? docId : focusedDocId();
    const doc = getDoc(id);
    if (!doc || doc.kind !== 'markdown') return;

    if (!doc.editMode) {
      patchDoc(id, { editMode: true });
      return;
    }
    // Leaving edit mode: the buffer becomes the source of truth for the reading view.
    const editor = editorRefs.current[id];
    const text = editor ? editor.getContent() : doc.source;
    const savedSource = editor ? editor.getSavedContent() : doc.savedSource;
    const textDirty = editor ? editor.isDirty() : !!doc.textDirty;
    const { fields, failed } = renderDoc(text, doc.path);
    if (failed) setStatusError(renderFailedMessage(doc.name));
    forgetEditor(id);
    patchDoc(id, { editMode: false, source: text, savedSource, textDirty, ...fields });
  };

  /* ── Split view & diff ───────────────────────────────────────────────────────────────────── */

  const toggleSplit = () => {
    if (splitIdRef.current !== null) {
      setSplit(null);
      setDiffData(null);
      return;
    }
    const ds = docsRef.current;
    if (ds.length < 2 || activeIdRef.current === null) {
      setStatusError('Open a second tab to use split view');
      return;
    }
    const idx = ds.findIndex((d) => d.id === activeIdRef.current);
    const other = ds[(idx + 1) % ds.length];
    setSplit(other.id);
  };

  const toggleDiff = () => {
    if (diffData) {
      setDiffData(null);
      return;
    }
    const a = getDoc(activeIdRef.current);
    if (!a) return;

    // With a split open: compare the two panes.
    const b = getDoc(splitIdRef.current);
    if (b) {
      setDiffData({
        leftText: docText(a), rightText: docText(b), leftName: a.name, rightName: b.name,
        leftFileName: a.name, rightFileName: b.name, docIds: [a.id, b.id]
      });
      return;
    }

    /*
     * No split: diff THIS file's unsaved edits against its last-saved state. The baseline is the
     * one the dirty flag uses (the editor's, or a reading-view Markdown tab's savedSource), so it
     * works without touching the disk and always agrees with the tab's dirty dot. The real file
     * names ride along for syntax highlighting.
     */
    const editor = editorRefs.current[a.id];
    const saved = editor ? editor.getSavedContent() : a.kind === 'markdown' ? a.savedSource : null;
    if (saved == null) {
      setStatusError('Open the document in the editor to diff unsaved changes');
      return;
    }
    if (!(editor ? editor.isDirty() : a.textDirty)) {
      setStatusError(
        formatChanged(a)
          ? 'The text is unchanged; only the line endings or encoding change when you save'
          : 'No unsaved changes to diff'
      );
      return;
    }
    setDiffData({
      leftText: saved,
      rightText: docText(a),
      leftName: `${a.name} (saved)`,
      rightName: `${a.name} (unsaved)`,
      leftFileName: a.name,
      rightFileName: a.name,
      docIds: [a.id]
    });
  };

  /* ── Commands: keyboard, menu, palette ───────────────────────────────────────────────────── */

  /*
   * Opening the palette and Settings. Every entry point (keys, the app menu, the palette's own
   * commands, buttons) comes through these two and says where to land: the palette's query
   * (':' Go to line, '@' Go to symbol) and the Settings page ('shortcuts', 'about'), so neither
   * reopens wherever it was last left.
   *
   * The palette's modes are built HERE, in the handler, not during render: their callbacks read
   * refs, and a fresh set per opening also starts their symbol cache fresh. Asked again while it
   * is open, the palette closes and reopens, so the query starts over; its focus handling sees a
   * clean close, and focus still goes back to the editor afterwards.
   */
  const openPalette = (query = '') => {
    if (showPaletteRef.current) {
      flushSync(() => setShowPalette(false));
    }
    setPaletteModes(
      createPaletteModes({
        getActiveDoc: () => getDoc(focusedDocId()),
        getActiveView: () => editorRefs.current[focusedDocId()]?.getView?.() ?? null,
        getDocs: () => docsRef.current,
        getDocText: (doc) => docText(doc),
        activateDoc: (id) => opsRef.current.showDoc(id),
        revealLine: (docId, line, col) => opsRef.current.revealLine(docId, line, col)
      })
    );
    setPaletteQuery(query);
    showPaletteRef.current = true;
    setShowPalette(true);
  };

  const closePalette = () => {
    showPaletteRef.current = false;
    setShowPalette(false);
  };

  /**
   * Settings, on `section` (never the page it was last left on). Settings follows a change of
   * page while open; asked for the page it already holds, it steps through "no page" first so the
   * request still lands after the user has moved elsewhere in it.
   */
  const openSettings = (section = 'appearance') => {
    if (showSettingsRef.current && settingsSectionRef.current === section) {
      flushSync(() => setSettingsSection(null));
    }
    settingsSectionRef.current = section;
    setSettingsSection(section);
    showSettingsRef.current = true;
    setShowSettings(true);
  };

  const closeSettings = () => {
    showSettingsRef.current = false;
    setShowSettings(false);
  };

  /** The CodeMirror view the user is typing in, else the focused doc's editor. */
  const targetEditorView = () => {
    const focused = document.activeElement;
    const view = focused?.closest?.('.cm-editor') ? EditorView.findFromDOM(focused.closest('.cm-editor')) : null;
    return view || editorRefs.current[focusedDocId()]?.getView?.() || null;
  };

  /** Edit → Find: the editor's own search panel, else the reading view's find bar. */
  const findInActive = () => {
    const view = targetEditorView();
    if (view) {
      openSearchPanel(view);
      return;
    }
    window.dispatchEvent(new CustomEvent('fate:find'));
  };

  /** Edit → Undo/Redo: a focused text field undoes itself; otherwise the editor's history. */
  const editHistory = (kind) => {
    const el = document.activeElement;
    const inField = el && !el.closest?.('.cm-editor') && (el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName));
    if (inField) {
      document.execCommand(kind);
      return;
    }
    const view = targetEditorView();
    if (!view) return;
    (kind === 'undo' ? undoEdit : redoEdit)(view);
    view.focus();
  };

  /**
   * Every rebindable action, by SHORTCUT_ACTIONS id (keyboard, the app menu, the palette). The
   * ones about a document act on the focused one (L3): the split pane's while it has focus.
   */
  const runAction = (id) => {
    const target = focusedDocId();
    switch (id) {
      case 'newFile': return newFile();
      case 'openFile': return window.electronAPI?.openFileDialog();
      case 'save': return saveDoc(target);
      case 'saveAs': return saveDoc(target, { forceAs: true });
      case 'print': return target !== null && openPrintPreview();
      case 'exportPdf': return target !== null && exportPdf();
      case 'closeTab':
      case 'close':
        return target !== null && closeDoc(target);
      case 'nextTab': return cycleTab(1);
      case 'prevTab': return cycleTab(-1);
      case 'goHome': return activate(null);
      case 'palette': return showPaletteRef.current ? closePalette() : openPalette('');
      case 'toggleEdit': return target !== null && toggleMarkdownEdit(target);
      case 'toggleSplit': return toggleSplit();
      case 'focusMode': return setFocusMode((f) => !f);
      case 'settings': return openSettings('appearance');
      default: return undefined;
    }
  };

  /** The application menu (main.cjs) sends these; ids per the contract in electron/preload.cjs. */
  const runMenuCommand = (command) => {
    switch (command) {
      case 'palette': return openPalette('');
      case 'settings': return openSettings('appearance');
      case 'shortcuts': return openSettings('shortcuts');
      case 'about': return openSettings('about');
      case 'find': return findInActive();
      case 'gotoLine': return openPalette(':');
      case 'gotoSymbol': return openPalette('@');
      case 'undo': return editHistory('undo');
      case 'redo': return editHistory('redo');
      default: return runAction(command);
    }
  };

  /**
   * Palette ":" "@" "#": put the caret on `line`, `col` (1-based) of a doc and show it. A doc
   * that isn't on screen is activated first; the split pane's is revealed where it is. The move
   * waits a frame, so a pane that has just been shown has its layout (a hidden editor can't
   * scroll).
   *
   * A Markdown tab in its reading view has no caret: the view scrolls to the rendered block that
   * the line belongs to. Rendered top-level blocks carry their 0-based source line (`data-line`,
   * markdown.js), and the last one at or before the line is it. Without those (a render that fell
   * back to plain text), the heading on that line, else the same fraction of the document.
   */
  const revealLine = (docId, line, col = 1) => {
    if (!getDoc(docId)) return;
    showDoc(docId);
    requestAnimationFrame(() => {
      const view = editorRefs.current[docId]?.getView?.();
      if (view) {
        const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
        const pos = Math.min(target.from + Math.max(0, (col || 1) - 1), target.to);
        view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
        view.focus();
        return;
      }
      const doc = getDoc(docId);
      const pane = document.querySelector(`.doc-pane[data-doc-id="${docId}"]`);
      const body = pane?.querySelector('.markdown-container .markdown-body');
      const scroller = body?.closest('.markdown-container');
      if (!doc || !body || !scroller) return;
      const wanted = line - 1;
      let block = null;
      for (const el of body.querySelectorAll('[data-line]')) {
        const at = Number(el.getAttribute('data-line'));
        if (at > wanted) break;
        if (el.getClientRects().length) block = el;
      }
      if (!block) {
        const raw = ((doc.source || '').split('\n')[wanted] || '')
          .replace(/^ {0,3}#{1,6}[ \t]*/, '')
          .replace(/[ \t]+#+[ \t]*$/, '')
          .trim();
        block = raw ? [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => h.textContent.trim() === raw) : null;
      }
      if (block) {
        scrollIntoPreview(block);
      } else {
        const lines = Math.max(1, (doc.source || '').split('\n').length);
        scroller.scrollTo({ top: (wanted / lines) * scroller.scrollHeight });
      }
    });
  };

  /*
   * Listeners registered once (IPC, the app menu, the keyboard, timers) reach the operations
   * above through this ref, refreshed after every render, so they always run the current closures.
   */
  useEffect(() => {
    opsRef.current = {
      openDocument, onDiskChange, markDeleted, restoreSession, runAction, runMenuCommand,
      handleQuitRequest, backupTick, flushBackupsNow, isDocDirty, activate, showDoc, revealLine,
      updateSetting, closeSettings
    };
  });

  /* ── Boot: stored settings + IPC listeners ───────────────────────────────────────────────── */

  /*
   * Runs once per page. React's development mode runs every effect twice (mount, cleanup, mount)
   * and nothing here can be undone by a cleanup: the session would be restored twice and every
   * IPC listener registered twice (L18). The guard is a ref, which survives that cleanup.
   */
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (window.electronAPI) {
      const api = window.electronAPI;
      // Hot-exit backups are listed with the settings, so they are ready before any file opens.
      const listBackups = api.backups?.list ? api.backups.list().catch(() => []) : Promise.resolve([]);
      Promise.all([
        api.store.get('theme'),
        api.store.get('autoUpdatesEnabled'),
        api.store.get('sidebarWidth'),
        api.store.get('shortcuts'),
        api.store.get('printPageSize'),
        api.store.get('printLandscape'),
        api.store.get('editorWrap'),
        api.store.get('editorTabSize'),
        api.store.get('editorLint'),
        api.store.get('fonts'),
        api.store.get('restoreSession'),
        api.store.get('customTheme'),
        api.store.get('session'),
        api.store.get('spellcheck'),
        api.store.get('remoteImages'),
        listBackups
      ])
        .then(([theme, autoUpdatesEnabled, savedSidebarWidth, shortcuts, printPageSize, printLandscape, editorWrap, editorTabSize, editorLint, fonts, restoreSession, customTheme, session, spellcheck, remoteImages, backups]) => {
          const resolvedCustom = resolveCustomTheme(customTheme);
          const resolvedTheme = resolveTheme(theme, !!resolvedCustom);
          const resolvedFonts = resolveFonts(fonts);
          const newSettings = {
            theme: resolvedTheme,
            autoUpdatesEnabled: autoUpdatesEnabled !== false,
            // Up to 1.13 the field stored every keystroke unchecked (L16): anything from 1 up.
            sidebarWidth: clampSidebarWidth(savedSidebarWidth),
            printPageSize: printPageSize || 'Letter',
            printLandscape: !!printLandscape,
            editorWrap: !!editorWrap,
            editorTabSize: [2, 4, 8].includes(editorTabSize) ? editorTabSize : 4,
            editorLint: editorLint !== false,
            fonts: resolvedFonts,
            restoreSession: restoreSession !== false,
            customTheme: resolvedCustom,
            shortcuts: resolveShortcuts(shortcuts),
            // Never chosen: on where it costs nothing (Windows' own checker), off on Linux, where
            // it downloads dictionaries from Google. Main applies the stored value at startup too.
            spellcheck: typeof spellcheck === 'boolean' ? spellcheck : api.platform === 'win32',
            remoteImages: remoteImages === true
          };
          // Before anything renders Markdown: the restore below opens documents.
          remoteImagesRef.current = newSettings.remoteImages;
          setSettings(newSettings);
          setSidebarWidth(newSettings.sidebarWidth);
          api.setSpellcheck?.(newSettings.spellcheck)?.catch?.(() => {});
          applyCustomTheme(resolvedCustom);
          document.documentElement.setAttribute('data-theme', resolvedTheme);
          applyFonts(resolvedFonts);

          // Persist the migration so the legacy value isn't re-resolved on every launch.
          if (theme !== resolvedTheme) {
            api.store.set('theme', resolvedTheme);
          }

          // Last session's tabs (if that setting is on) and any hot-exit backups (always).
          opsRef.current.restoreSession(newSettings.restoreSession ? session : null, backups);
        })
        .catch((err) => console.error('Could not restore settings at startup:', err))
        /*
         * Only now may the main process open the launch argument: a backup of that very file
         * must already be waiting for it, or its tab would open clean and the edits come back as
         * a duplicate.
         */
        .finally(() => api.appReady());

      const mergeFonts = (newFonts) => {
        if (!Array.isArray(newFonts) || newFonts.length === 0) return;
        setSystemFonts((prev) => Array.from(new Set([...prev, ...newFonts])).sort((a, b) => a.localeCompare(b)));
      };
      api.getSystemFonts?.().then(mergeFonts).catch(() => {});
      if (typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function') {
        window.queryLocalFonts().then((fonts) => {
          mergeFonts(fonts.map((f) => f.family));
        }).catch(() => {});
      }

      api.onOpenFile((content, name, path, meta) => {
        opsRef.current.openDocument(content, name, path, meta);
      });

      /*
       * Live-reload on external disk change, routed to the owning tab by path. Registered once.
       * Never clobbers unsaved edits: a dirty tab keeps the user's version and shows the
       * changed-on-disk bar (see applyDiskContent).
       */
      api.onFileChanged((content, changedPath, meta) => {
        opsRef.current.onDiskChange(content, changedPath, meta);
      });
      api.onFileDeleted?.((deletedPath) => opsRef.current.markDeleted(deletedPath));
      api.onMenuCommand?.((command, arg) => opsRef.current.runMenuCommand(command, arg));
      api.onRequestClose?.(() => opsRef.current.handleQuitRequest());

      api.getAppVersion().then((version) => setAppVersion(version));

      api.onUpdateMessage((message, action) => {
        setUpdateStatus(message);
        setUpdateAction(action);
      });

      refreshRecentFiles();
      refreshDefaultAppStatus();
    } else {
      // Browser dev mode (`npm run dev` without Electron): no store to read from.
      document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
      applyFonts(DEFAULT_FONTS);
    }
  }, [refreshRecentFiles, refreshDefaultAppStatus]);

  /* Hot exit: the backup tick, and the crash flush the root error boundary calls. */
  useEffect(() => {
    if (!window.electronAPI?.backups) return undefined;
    setCrashFlusher(() => opsRef.current?.flushBackupsNow());
    const timer = setInterval(() => opsRef.current?.backupTick(), BACKUP_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  /*
   * Unload guard. Anything that unloads the page with unsaved work and without going through the
   * quit walk (a reload from wherever it comes, a close the walk never saw) is blocked here; the
   * main process turns the block into a confirmation ('will-prevent-unload'). The quit walk and
   * the crash screen's Reload stand it down first.
   */
  useEffect(() => {
    window.onbeforeunload = (e) => {
      if (quittingRef.current) return undefined;
      const dirty = docsRef.current.some((d) => opsRef.current?.isDocDirty(d) ?? d.dirty);
      if (!dirty) return undefined;
      e.preventDefault();
      e.returnValue = false;
      return false;
    };
    return () => {
      window.onbeforeunload = null;
    };
  }, []);

  /* The app menu shows the live shortcut bindings as its labels (display only; keys stay here). */
  useEffect(() => {
    window.electronAPI?.updateMenu?.({ shortcuts: { ...settings.shortcuts, ...FIXED_MENU_SHORTCUTS } });
  }, [settings.shortcuts]);

  /*
   * One place owns the window title and the mirrored any-tab-dirty flag. Since 1.11.0 the title is
   * just the focused document's filename (the full app name shows on the home screen only); the
   * main process composes it; see composeTitle in main.cjs.
   */
  useEffect(() => {
    if (!window.electronAPI) return;
    const anyDirty = docs.some((d) => d.dirty);
    window.electronAPI.setEdited(anyDirty);
    window.electronAPI.setTitle(focusedDoc ? focusedDoc.name : null, !!focusedDoc?.dirty);
  }, [docs, focusedDoc]);

  /*
   * Persist the session (paths only) whenever the tab set or active tab changes, debounced. Each
   * path once: a doubled entry used to open a doubled tab, which then saved a tripled list (H6).
   * An active tab without a path (Untitled) is remembered by its hot-exit backup id instead, so
   * after a crash the restored buffer you were typing in is the one that comes back selected.
   *
   * With "reopen last session's tabs" off, the stored list is CLEARED rather than merely ignored
   * at launch. Someone who turns that off is saying they want FATE to start empty; leaving a list
   * of everything they had open sitting in the config file is not that.
   */
  useEffect(() => {
    if (!window.electronAPI) return;
    clearTimeout(sessionSaveTimerRef.current);
    if (!settings.restoreSession) {
      window.electronAPI.store.set('session', { paths: [], active: null });
      return;
    }
    sessionSaveTimerRef.current = setTimeout(() => {
      window.electronAPI.store.set('session', {
        paths: uniqueBy(docs.filter((d) => d.path).map((d) => d.path), pathKey),
        active: activeDoc?.path ?? null,
        activeBackup: activeDoc && !activeDoc.path ? activeDoc.backupId : null
      });
    }, 400);
    return () => clearTimeout(sessionSaveTimerRef.current);
  }, [docs, activeDoc, settings.restoreSession]);



  /*
   * Re-check the default-app association when the window regains focus. Coming back from
   * Windows Settings is the exact moment the answer may have changed. The home screen's recent
   * files too, while it shows: File → Open Recent → Clear, or a file opened elsewhere, changes
   * the list behind its back, and the menu has no way to tell this page.
   */
  useEffect(() => {
    const onFocus = () => {
      refreshDefaultAppStatus();
      if (activeIdRef.current === null) refreshRecentFiles();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshDefaultAppStatus, refreshRecentFiles]);

  /** Refresh recents whenever the home screen comes back into view. */
  useEffect(() => {
    if (activeId === null) refreshRecentFiles();
  }, [activeId, refreshRecentFiles]);

  /* ── Keyboard ────────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const handleKeyDown = (e) => {
      /*
       * CodeMirror handles its own keys first and calls preventDefault on anything it consumed
       * (Escape closing its search panel, Ctrl+S from its save keymap); acting on those here too
       * would double-fire. The palette, Settings, menus and pickers use the same convention.
       */
      if (e.defaultPrevented) return;

      /*
       * Recording a binding (Settings → Shortcuts), and only while Settings is open: up to 1.13 the
       * recorder stayed armed after Settings closed, and the next key typed anywhere, even a plain
       * letter in the editor, became the shortcut (M2). SettingsModal handles Escape itself
       * (cancel) and stops the recorder when it closes. A key that can't be a shortcut (modifiers
       * alone; a bare letter, Tab or Home, which would fire while typing) is swallowed and the
       * recorder keeps listening; the hint in Settings says what is accepted.
       */
      if (activeShortcutRebind && showSettings) {
        e.preventDefault();
        e.stopPropagation();
        const binding = bindingFromEvent(e);
        if (!binding || !isAllowedShortcut(binding)) return;
        opsRef.current.updateSetting('shortcuts', { ...settings.shortcuts, [activeShortcutRebind]: binding });
        setActiveShortcutRebind(null);
        return;
      }

      /*
       * Escape unwinds one layer at a time: the palette, Settings, menus and find bars handle it
       * themselves (they come first) → diff → focus mode → the tab (see ESCAPE_OWNERS).
       */
      if (e.key === 'Escape' && diffData) {
        setDiffData(null);
        return;
      }
      if (e.key === 'Escape' && focusMode) {
        setFocusMode(false);
        return;
      }
      if (showSettings && matchesShortcut(e, settings.shortcuts.close)) {
        opsRef.current.closeSettings();
        return;
      }

      // Fixed: Ctrl+1–9 jump (9 = last), Ctrl+PgUp/PgDn cycle.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const ds = docsRef.current;
        if (ds.length > 0) {
          const n = parseInt(e.key, 10);
          opsRef.current.activate(n === 9 ? ds[ds.length - 1].id : (ds[n - 1]?.id ?? ds[ds.length - 1].id));
        }
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        opsRef.current.runAction(e.key === 'PageDown' ? 'nextTab' : 'prevTab');
        return;
      }

      // A bare Escape inside an editor, field, control, menu, find bar or dialog is theirs (M1).
      const escapeHeld = isBareEscape(e) && escapeOwnedBy(e.target);

      // Every rebindable action, in declaration order.
      for (const { id } of SHORTCUT_ACTIONS) {
        if (matchesShortcut(e, settings.shortcuts[id])) {
          if (escapeHeld) return;
          // Escape-as-close must not swallow Escape while a modal layer is open above the tabs.
          if (id === 'close' && (showSettings || showPalette)) return;
          e.preventDefault();
          opsRef.current.runAction(id);
          return;
        }
      }

      // Ctrl+A outside any editor or field selects the document being read, not the whole window.
      // Last, so a shortcut rebound to Ctrl+A still wins.
      const t = e.target;
      const editable = t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName);
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'a' &&
          !editable && !showSettings && !showPalette && selectPreviewDocument()) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [settings.shortcuts, activeShortcutRebind, showSettings, showPalette, focusMode, diffData]);

  /* ── Update / drop / recents handlers ────────────────────────────────────────────────────── */

  const handleUpdateAction = () => {
    if (!window.electronAPI) return;
    if (updateAction === 'install') {
      window.electronAPI.installUpdate();
    } else {
      window.electronAPI.checkForUpdates();
    }
  };

  /*
   * ── Drag & drop, hand-rolled ────────────────────────────────────────────────────────────────
   * The WHOLE WINDOW is the drop target (drop onto the editor, a tab, anywhere, like any
   * desktop editor), not just the home-screen box. react-dropzone is gone: its FileSystemHandle
   * path broke webUtils.getPathForFile under Electron, and a drop that missed its zone fell
   * through to Chromium's default behaviour: NAVIGATING the app to the dropped file, which
   * looked exactly like "drag & drop doesn't work". Native DataTransfer.files keeps real paths,
   * and preventDefault() on window dragover/drop kills the navigation fallthrough for good (the
   * main process also refuses stray navigations now, as a second line of defence).
   */
  const handleDroppedFiles = (files) => {
    for (const file of files) {
      if (!file || !file.name) continue;

      if (file.size === 0 && file.type === '') {
        setStatusError(`Can't open ${file.name}: it looks like a folder`);
        continue;
      }

      // No extension check here; FATE opens any text file. With a real path the main process
      // applies the size cap and binary sniff (and shows a proper error box); the path-less
      // fallback below sniffs the decoded text itself.
      const resolvedPath = window.electronAPI?.getPathForFile?.(file) ?? file.path ?? null;

      // With a real path, route through the main process: watcher, recents, tab dedupe.
      if (resolvedPath && window.electronAPI?.openRecentFile) {
        window.electronAPI.openRecentFile(resolvedPath);
        continue;
      }

      setIsLoading(true);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        if (looksBinary(text)) {
          setIsLoading(false);
          setStatusError(`Can't open ${file.name}: it looks like a binary file`);
          return;
        }
        opsRef.current.openDocument(text, file.name, resolvedPath);
      };
      reader.readAsText(file);
    }
  };
  const handleDroppedFilesRef = useRef(handleDroppedFiles);
  useEffect(() => {
    handleDroppedFilesRef.current = handleDroppedFiles;
  });

  const [isDragActive, setIsDragActive] = useState(false);

  /* Copy buttons on code blocks, and clean copies out of every markdown preview. */
  useEffect(() => installPreviewClipboard(), []);

  useEffect(() => {
    // Depth counter because dragenter/dragleave fire for every child element crossed.
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

    /*
     * CAPTURE phase on the window, and file drags stop here (M3). CodeMirror has its own drop
     * handler: it read a dropped file and INSERTED its text at the drop point, on top of FATE
     * opening it in a tab, so dropping config.json onto app.js put the JSON inside app.js. Text
     * dragged within or into an editor carries no 'Files' type and passes through untouched.
     */
    const onDragEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setIsDragActive(true);
    };
    const onDragOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // REQUIRED, or the drop event never fires and Chromium navigates
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragActive(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      setIsDragActive(false);
      handleDroppedFilesRef.current(Array.from(e.dataTransfer.files));
    };

    window.addEventListener('dragenter', onDragEnter, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, []);

  const openRecent = (entry) => {
    if (!window.electronAPI?.openRecentFile) return;
    window.electronAPI.openRecentFile(entry.path).then((res) => {
      if (!res?.ok) refreshRecentFiles();
    });
  };

  const isWindows = defaultAppStatus?.supported === true;

  /* ── Command palette items ───────────────────────────────────────────────────────────────── */

  const canRenderAsMarkdown = focusedDoc?.kind === 'code' && couldBeMarkdown(focusedDoc.name);

  const paletteItems = showPalette
    ? [
        ...docs.map((d) => ({
          id: `tab-${d.id}`,
          section: 'Tabs',
          label: d.name,
          icon: d.kind === 'code' ? FileCode : FileText,
          run: () => activate(d.id)
        })),
        ...recentFiles
          .filter((r) => r.exists)
          .map((r) => ({
            id: `recent-${r.path}`,
            section: 'Recent',
            label: r.name,
            icon: ClockCounterClockwise,
            run: () => openRecent(r)
          })),
        { id: 'cmd-new', section: 'Commands', label: 'New file', icon: FilePlus, run: newFile },
        { id: 'cmd-open', section: 'Commands', label: 'Open file…', icon: FolderOpen, run: () => window.electronAPI?.openFileDialog() },
        { id: 'cmd-save', section: 'Commands', label: 'Save', icon: FloppyDisk, run: () => saveDoc() },
        { id: 'cmd-saveas', section: 'Commands', label: 'Save As…', icon: FloppyDisk, run: () => saveDoc(undefined, { forceAs: true }) },
        { id: 'cmd-print', section: 'Commands', label: 'Print preview', icon: Printer, run: openPrintPreview },
        { id: 'cmd-export', section: 'Commands', label: 'Export as PDF', icon: FilePdf, run: exportPdf },
        { id: 'cmd-edit', section: 'Commands', label: 'Edit / view markdown', icon: PencilSimple, run: () => toggleMarkdownEdit() },
        ...(canRenderAsMarkdown
          ? [{ id: 'cmd-render-md', section: 'Commands', label: 'Render as Markdown', icon: MarkdownLogo, run: () => renderAsMarkdown(focusedDoc.id) }]
          : []),
        { id: 'cmd-split', section: 'Commands', label: splitId ? 'Close split view' : 'Split view', icon: SquareSplitHorizontal, run: toggleSplit },
        { id: 'cmd-diff', section: 'Commands', label: diffData ? 'Exit diff' : splitId !== null ? 'Diff the split panes' : 'Diff unsaved changes', icon: GitDiff, run: toggleDiff },
        { id: 'cmd-focus', section: 'Commands', label: focusMode ? 'Exit focus mode' : 'Focus mode', icon: ArrowsOutSimple, run: () => setFocusMode((f) => !f) },
        { id: 'cmd-home', section: 'Commands', label: 'Go to home screen', icon: House, run: () => activate(null) },
        { id: 'cmd-close', section: 'Commands', label: 'Close tab', icon: X, run: () => opsRef.current.runAction('closeTab') },
        { id: 'cmd-settings', section: 'Commands', label: 'Open settings', icon: Gear, run: () => openSettings('appearance') },
        { id: 'cmd-shortcuts', section: 'Commands', label: 'Keyboard shortcuts', icon: Keyboard, run: () => openSettings('shortcuts') },
        { id: 'cmd-goto-line', section: 'Commands', label: 'Go to line…', icon: MagnifyingGlass, run: () => openPalette(':') },
        { id: 'cmd-goto-symbol', section: 'Commands', label: 'Go to symbol…', icon: MagnifyingGlass, run: () => openPalette('@') },
        { id: 'cmd-search-tabs', section: 'Commands', label: 'Search open tabs…', icon: MagnifyingGlass, run: () => openPalette('#') },
        { id: 'cmd-updates', section: 'Commands', label: 'Check for updates', icon: CircleNotch, run: handleUpdateAction },
        ...THEMES.map((t) => ({
          id: `theme-${t.value}`,
          section: 'Theme',
          label: `${t.label} (${t.sub})`,
          icon: Palette,
          run: () => updateSetting('theme', t.value)
        })),
        ...(settings.customTheme
          ? [{ id: 'theme-custom', section: 'Theme', label: 'Custom (your palette)', icon: Palette, run: () => updateSetting('theme', 'custom') }]
          : [])
      ]
    : [];

  /* ── Render helpers ──────────────────────────────────────────────────────────────────────── */

  /*
   * The tab strip follows the WAI-ARIA tabs pattern (L-a11y): one tab in the Tab order (the
   * active one, or the first on the home screen); Left/Right move focus along the strip, wrapping,
   * Home/End jump to the ends, Enter or Space activate the focused tab, and Delete closes it,
   * after which focus moves to the tab that took its place. Modified keys pass through (Alt+Home
   * is Go to home screen, Ctrl+Tab cycles), so the app's shortcuts still work from a tab.
   */
  const onTabKeyDown = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const tab = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
    if (!tab) return;
    const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const id = Number(tab.dataset.docId);
    let next;
    switch (e.key) {
      case 'ArrowRight': next = tabs[(i + 1) % tabs.length]; break;
      case 'ArrowLeft': next = tabs[(i - 1 + tabs.length) % tabs.length]; break;
      case 'Home': next = tabs[0]; break;
      case 'End': next = tabs[tabs.length - 1]; break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(id);
        return;
      case 'Delete':
        if (e.shiftKey) return;
        e.preventDefault();
        closeDoc(id).then((closed) => {
          if (!closed) return;
          // After the closed tab's pane (and any editor taking focus on activation) has settled.
          requestAnimationFrame(() => {
            const left = [...document.querySelectorAll('.tab-scroll [role="tab"]')];
            (left[i] || left[i - 1])?.focus();
          });
        });
        return;
      default:
        return;
    }
    if (e.shiftKey) return;
    e.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  /** The bars over a pane: the file changed or vanished under unsaved work, or a notice. */
  const renderDocBars = (d) => (
    <>
      {d.diskDeleted && (
        <DocBar
          tone="danger"
          message={`${d.name} was deleted or moved.`}
          actions={[
            { label: 'Keep editing', primary: true, title: 'Keep the text open as unsaved; Save writes the file again', onClick: () => patchDoc(d.id, { diskDeleted: false }) },
            { label: 'Close tab', onClick: () => closeDoc(d.id) }
          ]}
        />
      )}
      {d.diskChange && (
        <DocBar
          tone="warning"
          message={`${d.name} changed on disk.`}
          actions={[
            { label: 'Reload', title: 'Discard your edits and load the file from disk', onClick: () => reloadFromDisk(d.id) },
            { label: 'Keep mine', primary: true, title: 'Keep your edits; saving overwrites the file on disk', onClick: () => keepMine(d.id) },
            { label: 'Compare', title: 'Show the file on disk beside your version', onClick: () => compareWithDisk(d.id) }
          ]}
        />
      )}
      {d.notice && (
        <DocBar
          tone="info"
          message={d.notice.text}
          actions={
            d.notice.renderAction && d.kind === 'code' && couldBeMarkdown(d.name)
              ? [{ label: 'Render as Markdown', onClick: () => renderAsMarkdown(d.id) }]
              : []
          }
          onDismiss={() => patchDoc(d.id, { notice: null })}
        />
      )}
    </>
  );

  /*
   * One doc's pane. `active` is the tab strip's selection (it decides the layout: the active pane
   * sits left); `focused` is the doc commands act on, which can be the split pane (L3), and it is
   * what the editors and the reading view get as `isActive`: the Ln/Col readout, the reading
   * progress and focus-on-switch follow it.
   */
  const renderPane = (d) => {
    const active = d.id === activeId;
    const inSplit = splitId === d.id && !diffData;
    const visible = active || inSplit;
    const focused = d.id === focusedId;
    return (
      <div
        key={d.id}
        id={`pane-${d.id}`}
        role="tabpanel"
        aria-labelledby={`tab-${d.id}`}
        data-doc-id={d.id}
        className={`doc-pane ${active ? 'doc-pane-active' : ''} ${inSplit && !active ? 'doc-pane-split-right' : ''}`}
        style={
          d.kind === 'code'
            ? { display: visible ? 'flex' : 'none', '--editor-font': editorFontFor(d.name, settings.fonts) }
            : { display: visible ? 'flex' : 'none' }
        }
      >
        {inSplit && !active && (
          <div className="split-bar" key="splitbar">
            <select
              value={splitId ?? ''}
              onChange={(e) => {
                const id = parseInt(e.target.value, 10);
                setSplit(id);
                focusPane(id);
              }}
              aria-label="Document shown in the split pane"
            >
              {docs
                .filter((x) => x.id !== activeId)
                .map((x) => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
            </select>
            <button className="icon-btn" onClick={toggleDiff} title="Diff against the active tab">
              <GitDiff size={15} weight="duotone" />
            </button>
            <button className="icon-btn" onClick={() => { setSplit(null); setDiffData(null); }} title="Close split">
              <X size={14} weight="bold" />
            </button>
          </div>
        )}

        {renderDocBars(d)}

        {d.kind === 'markdown' ? (
          d.editMode ? (
            /* Spell checking and the doc's indentation reach the editor inside through context. */
            <EditorPrefsContext.Provider key="mdedit" value={{ spellcheck: !!settings.spellcheck, indent: indentOf(d) }}>
              <MarkdownEditView
                doc={d}
                isActive={focused}
                isVisible={visible}
                tabSize={settings.editorTabSize}
                cursorLabelRef={cursorLabelRef}
                onDirtyChange={(dirty) => handleDirtyChange(d.id, dirty)}
                onSave={() => saveDoc(d.id)}
                registerEditor={editorRefFor(d.id)}
                remoteImagesAllowed={!!settings.remoteImages}
              />
            </EditorPrefsContext.Provider>
          ) : (
            <MarkdownView
              key="mdview"
              doc={d}
              isActive={focused}
              isVisible={visible}
              sidebarWidth={sidebarWidth}
              onSidebarWidthChange={setSidebarWidth}
              progressBarRef={progressBarRef}
              progressLabelRef={progressLabelRef}
              remoteImagesAllowed={!!settings.remoteImages}
              onAllowRemoteImages={() => updateSetting('remoteImages', true)}
            />
          )
        ) : (
          <CodeEditor
            key="ed"
            ref={editorRefFor(d.id)}
            fileName={d.name}
            initialContent={d.codeContent}
            savedContent={d.savedContent}
            wrap={settings.editorWrap}
            tabSize={settings.editorTabSize}
            indent={indentOf(d)}
            lint={settings.editorLint}
            largeFile={d.largeFile}
            plainText={d.plainText}
            isActive={focused}
            onDirtyChange={(dirty) => handleDirtyChange(d.id, dirty)}
            onSave={() => saveDoc(d.id)}
            cursorLabelRef={cursorLabelRef}
          />
        )}

        {/* Print-only snapshots (populated on demand by runPrintJob, cleared after). */}
        {printSnapshot?.docId === d.id && printSnapshot.kind === 'code' && (
          <pre className="code-print-body" key="printsnap">{printSnapshot.text}</pre>
        )}
        {printSnapshot?.docId === d.id && printSnapshot.kind === 'markdown' && (
          <div className="md-print-body markdown-body" key="printmd" dangerouslySetInnerHTML={printSnapshot.markup} />
        )}
      </div>
    );
  };

  /* ── Render ──────────────────────────────────────────────────────────────────────────────── */

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      {/* ── Tab strip: visible whenever anything is open, home screen included ─────────────── */}
      {docs.length > 0 && (
        <div className="tab-strip">
          <button
            className={`tab-home ${activeId === null ? 'active' : ''}`}
            onClick={() => activate(null)}
            title="Home"
            aria-label="Home screen"
            aria-current={activeId === null ? 'page' : undefined}
          >
            <House size={17} weight="duotone" />
          </button>

          {/*
            * Each tab is a presentational wrapper (it takes the clicks, the middle-click close and
            * the right-click menu) around the role="tab" element and the close button, which sits
            * BESIDE the tab rather than inside it: a button nested in a tab is announced as part
            * of the tab and can't be reached on its own. The close button is for the mouse
            * (aria-hidden, out of the Tab order); from the keyboard a tab closes with Delete, or
            * the Close tab shortcut.
            */}
          <div className="tab-scroll" role="tablist" aria-label="Open documents" onKeyDown={onTabKeyDown}>
            {docs.map((d, i) => {
              const selected = d.id === activeId;
              const inTabOrder = activeId === null ? i === 0 : selected;
              return (
                <div
                  key={d.id}
                  role="presentation"
                  className={`tab ${selected ? 'active' : ''}`}
                  onClick={() => activate(d.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeDoc(d.id);
                    }
                  }}
                  onContextMenu={(e) => openTabMenu(e, d)}
                >
                  <div
                    role="tab"
                    id={`tab-${d.id}`}
                    className="tab-main"
                    data-doc-id={d.id}
                    tabIndex={inTabOrder ? 0 : -1}
                    aria-selected={selected}
                    aria-controls={`pane-${d.id}`}
                    aria-label={d.dirty ? `${d.name}, unsaved changes` : d.name}
                    title={d.path || d.name}
                  >
                    {d.kind === 'code'
                      ? <FileCode size={14} weight="duotone" className="tab-icon" />
                      : <FileText size={14} weight="duotone" className="tab-icon" />}
                    <span className="tab-name">{d.name}</span>
                    {d.dirty && <span className="dirty-dot" title="Unsaved changes" />}
                  </div>
                  <button
                    type="button"
                    className="tab-close"
                    tabIndex={-1}
                    aria-hidden="true"
                    // A click closes without taking focus (it stays in the editor, off a hidden control).
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDoc(d.id);
                    }}
                    title={`Close (${fmtShortcut(settings.shortcuts.closeTab)})`}
                  >
                    <X size={11} weight="bold" />
                  </button>
                </div>
              );
            })}
          </div>

          <button className="icon-btn tab-add" onClick={newFile} title={`New file (${fmtShortcut(settings.shortcuts.newFile)})`}>
            <FilePlus size={15} weight="bold" />
          </button>
          <button
            className="icon-btn tab-add"
            onClick={() => window.electronAPI?.openFileDialog()}
            title={`Open file (${fmtShortcut(settings.shortcuts.openFile)})`}
          >
            <Plus size={15} weight="bold" />
          </button>
        </div>
      )}

      {/* Reading progress is a markdown concept; the code editor has Ln/Col in the status bar. */}
      {focusedDoc?.kind === 'markdown' && !focusedDoc.editMode && (
        <div className="progress-bar-container">
          <div className="progress-bar" ref={progressBarRef} />
        </div>
      )}

      <div className="app-main">
        {!activeDoc && (
          /* ── HOME (also shown behind the tab strip when no tab is active) ─────────────────── */
          <>
            <Starfield />

            <div className="home">
              <header className="home-brand">
                <img src={fateLogo} alt="" className="brand-badge" />
                <h1 className="brand-wordmark">FATE</h1>
                <p className="brand-subtitle">Formatted Article &amp; Text Editor</p>
                <p className="brand-credit">Provided by VagueDustin Enterprises&trade;</p>
              </header>

              <div className="home-panes">
                <section className="pane pane-open" aria-label="Open a document">
                  <div
                    className={`dropzone ${isDragActive ? 'active' : ''}`}
                    onClick={() => window.electronAPI?.openFileDialog()}
                    role="button"
                    tabIndex={-1}
                  >
                    {isLoading ? (
                      <>
                        <CircleNotch className="dz-icon spinner" weight="bold" />
                        <p className="dz-title">Rendering document…</p>
                      </>
                    ) : (
                      <>
                        <UploadSimple className="dz-icon" weight="duotone" />
                        <p className="dz-title">
                          {isDragActive ? 'Release to open' : 'Drag & drop any text file'}
                        </p>
                        <span className="dz-sub">markdown &middot; code &middot; configs &middot; logs &middot; scripts &middot; &hellip;</span>
                      </>
                    )}
                  </div>

                  <div className="home-actions">
                    <button
                      className="btn btn-primary btn-open"
                      onClick={() => window.electronAPI?.openFileDialog()}
                    >
                      <FolderOpen size={17} weight="duotone" />
                      Open File
                      <span className="kbd-group">
                        {kbdChips(settings.shortcuts.openFile).map((k) => <kbd key={k}>{k}</kbd>)}
                      </span>
                    </button>
                    <button className="btn btn-secondary btn-open" onClick={newFile}>
                      <FilePlus size={17} weight="duotone" />
                      New File
                      <span className="kbd-group">
                        {kbdChips(settings.shortcuts.newFile).map((k) => <kbd key={k}>{k}</kbd>)}
                      </span>
                    </button>
                  </div>
                </section>

                <section className="pane pane-recent" aria-label="Recent documents">
                  <div className="pane-head">
                    <h2 className="section-label">
                      <ClockCounterClockwise size={13} weight="bold" />
                      Recent
                    </h2>
                    {recentFiles.length > 0 && (
                      <button
                        className="link-btn"
                        onClick={() => window.electronAPI?.clearRecentFiles().then(refreshRecentFiles)}
                        title="Clear recent documents"
                      >
                        <Trash size={13} weight="bold" />
                        Clear
                      </button>
                    )}
                  </div>

                  {recentFiles.length === 0 ? (
                    <div className="pane-empty">
                      <FileText size={26} weight="duotone" />
                      <p>No documents yet</p>
                      <span>Files you open will appear here</span>
                    </div>
                  ) : (
                    <ul className="recent-list">
                      {recentFiles.map((entry) => (
                        <li key={entry.path}>
                          <button
                            className={`recent-item ${entry.exists ? '' : 'missing'}`}
                            onClick={() => openRecent(entry)}
                            title={entry.exists ? entry.path : `${entry.path} (no longer exists)`}
                          >
                            {fileKindForName(entry.name) === 'code'
                              ? <FileCode size={17} weight="duotone" className="recent-icon" />
                              : <FileText size={17} weight="duotone" className="recent-icon" />}
                            <span className="recent-text">
                              <span className="recent-name">{entry.name}</span>
                              <span className="recent-dir">
                                {entry.exists ? shortenDir(entry.dir) : 'File not found'}
                              </span>
                            </span>
                            <span className="recent-time">{relativeTime(entry.openedAt)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </>
        )}

        {/* ── DOCUMENT PANES: all mounted; active (and split) visible ────────────────────── */}
        {docs.length > 0 && (
          <div className="viewer-shell" style={{ display: activeDoc ? 'flex' : 'none' }}>
            {/* The header is the FOCUSED doc's (the split pane's while it has focus; L3). */}
            {focusedDoc && (
              <div className="viewer-header">
                <div className="header-left">
                  <div className="file-info">
                    {focusedDoc.kind === 'code'
                      ? <FileCode className="file-icon" size={19} weight="duotone" />
                      : <FileText className="file-icon" size={19} weight="duotone" />}
                    <span className="file-name">{focusedDoc.name}</span>
                    {focusedDoc.dirty && <span className="dirty-dot" title="Unsaved changes" />}
                  </div>
                </div>

                <div className="header-right">
                  {focusedDoc.kind === 'markdown' && (
                    /* THE edit/view switch, deliberately a labelled button, not a mystery icon. */
                    <button
                      className={`btn btn-compact edit-toggle ${focusedDoc.editMode ? 'btn-secondary' : 'btn-primary'}`}
                      onClick={() => toggleMarkdownEdit(focusedDoc.id)}
                      title={`${focusedDoc.editMode ? 'Back to reading view' : 'Edit this document'} (${fmtShortcut(settings.shortcuts.toggleEdit)})`}
                    >
                      {focusedDoc.editMode
                        ? <><Eye size={15} weight="duotone" /> View</>
                        : <><PencilSimple size={15} weight="duotone" /> Edit</>}
                    </button>
                  )}
                  {canRenderAsMarkdown && (
                    <button
                      className="icon-btn"
                      onClick={() => renderAsMarkdown(focusedDoc.id)}
                      title="Render as Markdown"
                      aria-label="Render as Markdown"
                    >
                      <MarkdownLogo size={17} weight="duotone" />
                    </button>
                  )}
                  {(focusedDoc.kind === 'code' || focusedDoc.editMode || focusedDoc.dirty) && (
                    <button
                      className="icon-btn"
                      onClick={() => saveDoc(focusedDoc.id)}
                      disabled={!focusedDoc.dirty && !focusedDoc.untitled}
                      title={`Save (${fmtShortcut(settings.shortcuts.save)})`}
                    >
                      <FloppyDisk size={17} weight="duotone" />
                    </button>
                  )}
                  <button
                    className={`icon-btn ${splitId !== null ? 'toggled' : ''}`}
                    onClick={toggleSplit}
                    title={`Split view (${fmtShortcut(settings.shortcuts.toggleSplit)})`}
                  >
                    <SquareSplitHorizontal size={17} weight="duotone" />
                  </button>
                  <button
                    className={`icon-btn ${diffData ? 'toggled' : ''}`}
                    onClick={toggleDiff}
                    title={diffData ? 'Exit diff (Esc)' : splitId !== null ? 'Diff the split panes' : 'Diff unsaved changes against the saved file'}
                  >
                    <GitDiff size={17} weight="duotone" />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={exportPdf}
                    disabled={isPrinting}
                    title={`Export as PDF (${fmtShortcut(settings.shortcuts.exportPdf)})`}
                  >
                    <FilePdf size={17} weight="duotone" />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={openPrintPreview}
                    disabled={isPrinting}
                    title={`Print preview (${fmtShortcut(settings.shortcuts.print)})`}
                  >
                    {isPrinting
                      ? <CircleNotch size={17} weight="bold" className="spinner" />
                      : <Printer size={17} weight="duotone" />}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => openSettings('appearance')}
                    title={`Settings (${fmtShortcut(settings.shortcuts.settings)})`}
                  >
                    <Gear size={17} weight="duotone" />
                  </button>
                </div>
              </div>
            )}

            {/* Diff replaces the panes VISUALLY; the panes stay mounted underneath. */}
            {diffData && <DiffView {...diffData} />}
            {/* Focus or a click inside a pane makes its doc the focused one (L3). `print-right`
                swaps the split pane in for a print of its doc (see runPrintJob). */}
            <div
              className={`doc-panes ${splitId !== null && !diffData ? 'split' : ''} ${printSnapshot && printSnapshot.docId !== activeId ? 'print-right' : ''}`}
              style={{ display: diffData ? 'none' : undefined }}
              onFocus={onPaneFocusEvent}
              onPointerDown={onPaneFocusEvent}
            >
              {docs.map(renderPane)}
            </div>
          </div>
        )}
      </div>

      {/* Status bar: in the layout flow, not floating (see AI_CONTEXT.md §3a). Its document items
          are the FOCUSED doc's: the split pane's while it has focus (L3). */}
      <footer className="status-bar">
        <button className="status-btn" onClick={() => openSettings('appearance')}>
          <Gear size={15} weight="duotone" />
          <span className="status-btn-label">Settings</span>
        </button>
        <button className="status-btn" onClick={() => openPalette('')} title={`Command palette (${fmtShortcut(settings.shortcuts.palette)})`}>
          <MagnifyingGlass size={14} weight="bold" />
        </button>

        <span className="status-divider" />
        <span className="status-version">v{appVersion || '-'}</span>

        {focusedDoc?.kind === 'markdown' && !focusedDoc.editMode && (
          <>
            <span className="status-divider" />
            <span className="status-read">
              <span ref={progressLabelRef}>0%</span> read &middot; ~{focusedDoc.readMins} min
            </span>
          </>
        )}

        {(focusedDoc?.kind === 'code' || focusedDoc?.editMode) && (
          <>
            <span className="status-divider" />
            <span
              className="status-lang"
              title={focusedDoc.largeFile
                ? 'Detected language. Large file: syntax checking, bracket matching and autocompletion are off'
                : 'Detected language'}
            >
              {focusedDoc.kind === 'code' ? focusedDoc.langName : 'Markdown'}
            </span>
            <span className="status-divider" />
            <span className="status-cursor" ref={cursorLabelRef}>Ln 1, Col 1</span>
            <IndentStatus
              key={focusedDoc.id}
              indent={indentOf(focusedDoc)}
              onChange={(indent) => setDocIndent(focusedDoc.id, indent)}
            />
          </>
        )}

        {focusedDoc?.format && (
          <FormatStatus
            key={focusedDoc.id}
            format={focusedDoc.format}
            canReopen={!!focusedDoc.path && !focusedDoc.dirty}
            reopenHint={focusedDoc.path ? 'Save or discard your changes first' : 'Save the file first'}
            onToggleEol={() => toggleEol(focusedDoc.id)}
            onSaveWithEncoding={(choice) => setEncoding(focusedDoc.id, choice)}
            onReopenWithEncoding={(encoding) => reopenWithEncoding(focusedDoc.id, encoding)}
          />
        )}

        {focusedDoc?.kind === 'code' && focusedDoc.path && (
          <>
            <span className="status-divider" />
            <button
              type="button"
              className={`status-btn status-follow ${focusedDoc.follow ? 'accent' : ''}`}
              aria-pressed={!!focusedDoc.follow}
              onClick={() => toggleFollow(focusedDoc.id)}
              title="Follow: when the file grows on disk, reload it and scroll to the end (for logs)"
            >
              <ArrowLineDown size={13} weight="bold" />
              Follow
            </button>
          </>
        )}

        <span className="status-spacer" />

        {statusError && (
          <button
            className="status-badge status-badge-error"
            onClick={() => setStatusError('')}
            title={`${statusError} (click to dismiss)`}
          >
            <Warning size={13} weight="fill" />
            {statusError}
          </button>
        )}

        {isWindows && defaultAppStatus?.isDefault && (
          <span className="status-badge" title="FATE opens .md files by default">
            <CheckCircle size={13} weight="fill" />
            Default for .md
          </span>
        )}

        <button
          className={`status-btn ${updateAction === 'install' ? 'accent' : ''}`}
          onClick={handleUpdateAction}
          title={runtimeInfo.updates?.managed ? `Updates come from ${runtimeInfo.updates.label}` : 'Check for updates'}
        >
          {runtimeInfo.updates?.managed ? `Updates via ${runtimeInfo.updates.label}` : (updateStatus || 'Check for updates')}
        </button>
      </footer>

      {/* Whole-window drop affordance, visible whenever files are dragged over the app. */}
      {isDragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-badge">
            <UploadSimple size={28} weight="duotone" />
            Release to open
          </div>
        </div>
      )}

      {showPalette && (
        <CommandPalette
          items={paletteItems}
          modes={paletteModes}
          initialQuery={paletteQuery}
          onClose={closePalette}
        />
      )}

      {showSettings && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={closeSettings}
          settings={settings}
          updateSetting={updateSetting}
          appVersion={appVersion}
          defaultAppStatus={defaultAppStatus}
          requestDefaultApp={requestDefaultApp}
          activeShortcutRebind={activeShortcutRebind}
          setActiveShortcutRebind={setActiveShortcutRebind}
          onSidebarWidthChange={setSidebarWidth}
          runtimeInfo={runtimeInfo}
          systemFonts={systemFonts}
        />
      )}
    </div>
  );
}

export default App;
