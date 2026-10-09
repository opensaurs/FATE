const { app, BrowserWindow, ipcMain, shell, protocol, dialog, net, Menu, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const { describeFsError } = require('./fsAccess.cjs');
const { isAllowedNavigation, classifyExternalUrl, resolveLocalImagePath } = require('./linkSecurity.cjs');
const appMenu = require('./appMenu.cjs');
const { createSpellcheckController, resolveSpellcheckSetting } = require('./spellcheck.cjs');
const { removeStaleTempFiles } = require('./tempCleanup.cjs');
const { candidateFilePaths } = require('./launchArgs.cjs');

/**
 * ProgId that electron-builder's NSIS installer actually registers for `.md`.
 *
 * This is taken from `build.fileAssociations[].name` in package.json, NOT from
 * `build.appx.applicationId` as previously assumed. Verified against a real install:
 *
 *     HKLM\SOFTWARE\Classes\.md                       (default) = "Markdown Document"
 *     HKLM\SOFTWARE\Classes\Markdown Document\shell\open\command
 *         = "C:\Program Files\FATE\FATE - Markdown Viewer\FATE - Markdown Viewer.exe" "%1"
 *
 * It is only a HINT here. Because "Markdown Document" is a generic name that another application
 * could plausibly claim, `getDefaultAppStatus()` does not trust it: it resolves the ProgId's open
 * command and checks that the command actually points at THIS executable. See below.
 */
const MD_PROG_ID_HINT = 'Markdown Document';

/**
 * ProgId the installer registers for code files (see build/installer.nsh). Unlike `.md`, code
 * extensions are NEVER claimed as defaults by the installer; the ProgId is attached to each
 * extension's OpenWithProgids list (adds FATE to "Open with" without touching anyone's default)
 * and declared under FATE's Capabilities so every type is offered on FATE's page in Windows
 * Settings → Default apps.
 */
const CODE_PROG_ID = 'FATE.CodeFile';

/** How many recent documents to remember. Eight fills the home-screen panel without scrolling. */
const MAX_RECENT_FILES = 8;

/* ════════════════════════════════════════════════════════════════════════════════════════════
   FILE TYPES
   The main process reads bytes and watches paths; it does not care what a file *is*. FATE opens
   ANY text file. The only gates are size (MAX_FILE_BYTES) and a binary sniff (isProbablyBinary,
   in fileFormat.cjs).
   These lists exist for the curated open-dialog filters and for Windows registration (which
   types the installer advertises FATE for). Up to 1.12.0 they ALSO gated the command line and
   drag & drop, so "Edit in FATE" on a `.config`, `.properties`, `.reg`, `.csv` or any other
   unlisted extension did nothing at all, silently, which is the one thing an editor must never do.
   The renderer owns the markdown-vs-code routing decision (see fileKindForName in App.jsx).
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/*
 * The types registered with the "Markdown Document" ProgID on Windows. `txt` stays here although
 * since 1.14.0 the renderer opens .txt as plain text (fileKinds.js): a registration moved to another
 * ProgID would orphan the default users already gave FATE for .txt, and Windows answers that by
 * resetting it. The ProgID decides the icon and the Explorer type name, not how FATE opens the file.
 */
const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'txt'];

/** Code files offered in the open dialog's curated filter and registered on Windows. */
const CODE_EXTENSIONS = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less',
  'ps1', 'psm1', 'psd1', 'py', 'pyw', 'rb', 'php', 'sql',
  'xml', 'xsl', 'svg', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'sh', 'bash', 'zsh', 'bat', 'cmd',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hxx', 'cs', 'java', 'go', 'rs',
  'swift', 'kt', 'kts', 'dart', 'lua', 'r', 'pl', 'pm', 'scala', 'groovy', 'gradle',
  'vue', 'svelte', 'tex', 'diff', 'patch', 'log', 'env',
  'proto', 'graphql', 'gql', 'vb', 'fs', 'fsx', 'erl', 'ex', 'exs', 'hs',
  'clj', 'cljs', 'edn', 'nim', 'zig', 'jl', 'asm'
];

/**
 * Types FATE must NEVER register against in any way, not even "politely".
 *
 * `.bat` and `.cmd` resolve to the system ProgIds `batfile`/`cmdfile`, whose open command is
 * `"%1" %*`: the script IS the executable. Two consequences, and the second one is the trap.
 *
 *  1. No application name appears in that command, so Windows' "Choose a default" picker has
 *     nothing to offer for putting it back. Losing the default is a ONE-WAY DOOR.
 *
 *  2. MERELY BEING LISTED in the type's `OpenWithProgids` breaks it. Windows then sees two
 *     candidate handlers with no UserChoice to arbitrate, and shows "Pick an app" instead of
 *     running the script. Measured directly: `.reg` ran its handler normally, gained ONE
 *     OpenWithProgids entry, and immediately started showing the picker; removing the entry
 *     restored it. So the harmless-looking `OpenWithProgids` registration that makes FATE a
 *     polite option for `.py` is destructive for any type whose handler is a system ProgId that
 *     runs the file itself.
 *
 * Up to 1.11.5 both were registered like every other code type, which broke `.cmd` outright and
 * `.bat` twice over (the registration, plus a UserChoice for anyone who then picked FATE on its
 * Default-apps page).
 *
 * This is about REGISTRATION only. Both stay in CODE_EXTENSIONS, so the open dialog, drag & drop,
 * the command line and "Edit in FATE" all still open them; FATE just never advertises itself as
 * a handler.
 */
const PROTECTED_EXTENSIONS = ['bat', 'cmd'];

/** Every type FATE may register against: what the installer writes and the coverage counter walks. */
const ASSOCIABLE_CODE_EXTENSIONS = CODE_EXTENSIONS.filter((e) => !PROTECTED_EXTENSIONS.includes(e));
const ASSOCIABLE_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...ASSOCIABLE_CODE_EXTENSIONS];

/**
 * Refuse files above this size rather than feeding them to the renderer. 25 MB of text is already
 * an unpleasant document; past that the single-string IPC payload and the editor both suffer, and
 * the likeliest candidates (giant logs, minified bundles) aren't things FATE is for.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Is this command-line argument a file the user wants opened?
 *
 * Deliberately NOT an extension check. argv carries the exe path, Chromium switches, and in dev
 * the app path, none of which name a file the user picked, so this filters on shape (a flag?
 * an existing regular file? part of FATE itself?) and leaves "is it text?" to the size cap and
 * the binary sniff in openAndWatchFile, which show a proper error box instead of silently
 * ignoring the file. Up to 1.12.0 this was an extension whitelist, and an `Open with → FATE` on
 * anything not on it (`web.config`, say) did nothing whatsoever.
 */
function isOpenableArg(arg) {
  if (!arg || arg.startsWith('-')) return false;
  let stat;
  try {
    stat = fs.statSync(arg);
  } catch (err) {
    // Under snap confinement a path the sandbox may not see fails with EACCES, not ENOENT; the
    // user still asked for that file. Keep it and let openAndWatchFile say why it will not open;
    // up to 1.13.2 this returned false and `Open with → FATE` from a USB stick did nothing.
    return err.code === 'EACCES' || err.code === 'EPERM';
  }
  if (!stat.isFile()) return false;
  // `electron electron/main.cjs` in dev: the entry file exists and is a file, but it is FATE.
  if (path.resolve(arg) === __filename) return false;
  return true;
}

/**
 * The registered application name (Windows Settings, RegisteredApplications) and the home-screen
 * window title. Renamed from "FATE - Markdown Viewer" in 1.11.0, since the app is a full editor now.
 */
const APP_TITLE = 'FATE - Formatted Article & Text Editor';

/**
 * The window title. Since 1.11.0, BY EXPLICIT CHOICE, an open document titles the window with just
 * its filename (plus the unsaved •); the full app name shows only on the home screen. Yes, that
 * means the taskbar label leads with the filename. That is the requested behaviour, superseding
 * the pre-1.11 "app name must lead" rule.
 *
 * Composition still lives here rather than in the renderer so there is exactly one place that
 * decides what the window is called.
 */
function composeTitle(docName, edited) {
  return docName ? `${docName}${edited ? ' •' : ''}` : APP_TITLE;
}

/*
 * Dev/test escape hatch: point userData somewhere else so a test instance can run beside a real
 * installed FATE (the single-instance lock and the Chromium profile are both scoped to userData).
 * Must run before Store() below touches the path. No effect unless the env var is set.
 */
if (process.env.FATE_USER_DATA) {
  app.setPath('userData', process.env.FATE_USER_DATA);
}

/*
 * One FATE per profile. Opening a file while FATE runs starts a second process, which hands its
 * command line to the first ('second-instance', at the bottom of this file) and quits.
 *
 * Taken HERE, as early as possible: the lock lives in userData, so after the override above, and
 * before anything below starts real work. Up to 1.13.4 it was taken at the very end of the file,
 * after app.whenReady() had been wired up, and app.quit() before 'ready' does not stop 'ready'
 * from firing. So the losing instance still created a window and ran the Windows registration
 * self-heal (a reg import) and the association repair (PowerShell) before it went away. Now the
 * whenReady work returns at once without the lock; see the first line there.
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

const store = new Store({
  defaults: {
    // 'fate' = VagueDustin Enterprises navy & gold (utility tier), the default since 1.5.0.
    // Installs carrying the pre-1.5.0 'dark' value are migrated to 'fate' in the renderer; see
    // resolveTheme() in src/App.jsx. 'dark' no longer has a token block, so it must not survive.
    theme: 'fate',
    autoUpdatesEnabled: true,
    sidebarWidth: 300,
    shortcuts: {
      openFile: 'Control+O',
      print: 'Control+P',
      close: 'Escape'
    },
    recentFiles: [],
    // Page setup for print preview and PDF export. 'Letter' rather than 'A4' because the app is
    // Windows-only and US Letter is the more common default there; both are offered in Settings.
    printPageSize: 'Letter',
    printLandscape: false,
    // On where it is free (Windows' own checker); off elsewhere, where turning it on downloads a
    // dictionary from Google's servers. See electron/spellcheck.cjs.
    spellcheck: process.platform === 'win32'
  }
});

/*
 * Drop settings that no longer exist, so an upgraded install doesn't carry dead keys forever.
 * Add the key of any setting you remove to this list; it is deleted from existing configs on the
 * next launch, so the on-disk file matches what the app actually reads.
 */
for (const staleKey of []) {
  if (store.has(staleKey)) store.delete(staleKey);
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RECENT DOCUMENTS
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The stored list, minus anything malformed. Every open records itself here, so one bad entry
 * (a hand-edited config.json, or one written before the renderer lost write access to this key)
 * must not be able to throw and break opening files.
 */
function storedRecents() {
  const entries = store.get('recentFiles');
  return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.path === 'string' && entry.path) : [];
}

/**
 * The recents list changed (an open, a Save As, Clear, a dead entry dropped). The application
 * menu's Open Recent rebuilds from this event; it carries the stored list, [{ path, openedAt }],
 * newest first.
 */
function recentsChanged() {
  app.emit('fate-recents-changed', storedRecents());
}

/**
 * Record a document in the recents list: newest first, de-duplicated by path, capped.
 * Stores only the path and a timestamp. The display name and existence check are derived on read,
 * so a moved or renamed file cannot leave a stale name behind in the store.
 *
 * On Windows the document also goes into the Recent category of FATE's taskbar Jump List.
 */
function rememberRecentFile(filePath) {
  const existing = storedRecents();
  const normalized = path.normalize(filePath);
  const key = watchKey(filePath);
  const deduped = existing.filter((entry) => watchKey(entry.path) !== key);
  deduped.unshift({ path: normalized, openedAt: Date.now() });
  store.set('recentFiles', deduped.slice(0, MAX_RECENT_FILES));
  if (process.platform === 'win32') app.addRecentDocument(normalized);
  recentsChanged();
}

/** Drop one entry whose file is gone, so the list heals itself instead of offering it again. */
function forgetRecentFile(filePath) {
  const existing = storedRecents();
  const key = watchKey(filePath);
  const remaining = existing.filter((entry) => watchKey(entry.path) !== key);
  if (remaining.length === existing.length) return;
  store.set('recentFiles', remaining);
  recentsChanged();
}

/** Clear the list, and on Windows the Jump List too: whoever clears one expects both gone. */
function clearRecentFiles() {
  store.set('recentFiles', []);
  if (process.platform === 'win32') app.clearRecentDocuments();
  recentsChanged();
}

/*
 * The home screen's existence checks run in parallel and off the main thread. Up to 1.13.4 they
 * were fs.existsSync in a loop, so one entry on a disconnected network drive froze the window for
 * the whole network timeout. They also stop waiting after RECENT_CHECK_TIMEOUT_MS: an entry with
 * no answer by then shows as present, because opening it will say what is wrong, while greying it
 * out as "File not found" just because a server is slow would be false. A check still running
 * from an earlier visit is reused rather than repeated, so a dead share ties up one libuv thread,
 * not one more per visit.
 */
const RECENT_CHECK_TIMEOUT_MS = 1500;
const existenceChecks = new Map();

function isExistingFile(filePath) {
  let check = existenceChecks.get(filePath);
  if (!check) {
    check = fs.promises
      .stat(filePath)
      .then((stat) => stat.isFile(), () => false)
      .finally(() => existenceChecks.delete(filePath));
    existenceChecks.set(filePath, check);
  }
  return check;
}

/**
 * Read the recents list, annotating each entry with its display name and whether it still exists.
 * Missing files are returned rather than filtered out so the UI can show them greyed with a reason:
 * silently dropping an entry looks like the app forgot the file.
 */
async function readRecentFiles() {
  const entries = storedRecents();
  const deadline = new Promise((resolve) => setTimeout(resolve, RECENT_CHECK_TIMEOUT_MS, true));
  return Promise.all(
    entries.map(async (entry) => ({
      path: entry.path,
      name: path.basename(entry.path),
      dir: path.dirname(entry.path),
      openedAt: entry.openedAt,
      exists: await Promise.race([isExistingFile(entry.path), deadline])
    }))
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   DEFAULT-APP ASSOCIATION (Windows)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Promise wrapper around `reg query`. Resolves the raw stdout, or null on any failure. */
function regQuery(args) {
  return new Promise((resolve) => {
    execFile('reg', ['query', ...args], { windowsHide: true }, (err, stdout) => {
      resolve(err || !stdout ? null : stdout);
    });
  });
}

/**
 * Read the ProgId Windows currently uses to open a given extension.
 *
 * ── The key that matters ──────────────────────────────────────────────────────────────────────
 * This reads:
 *     HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\<ext>\UserChoice
 *
 * NOT `HKCU\Software\Classes\<ext>\UserChoice`, which is where an earlier version of this function
 * looked. That key does not exist on Windows 10/11, and the result was that FATE reported "no app is
 * set for .md files yet" even when Windows Settings plainly showed FATE as the handler. The
 * FileExts location is the one Explorer actually consults and the one the Settings UI writes.
 *
 * Note the value is NOT quoted in `reg` output and the ProgId can contain spaces (ours is
 * "Markdown Document"), so the capture runs to end-of-line rather than to the first whitespace.
 *
 * Resolves null when there is no explicit user choice yet.
 */
async function readUserChoiceProgId(ext) {
  if (process.platform !== 'win32') return null;
  const stdout = await regQuery([
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
    '/v',
    'ProgId'
  ]);
  if (!stdout) return null;
  // "    ProgId    REG_SZ    Markdown Document"
  const match = stdout.match(/ProgId\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im);
  return match ? match[1].trim() : null;
}

/**
 * Resolve a ProgId to the command line Windows would run for it.
 * Checks HKCU first (per-user registrations win), then HKLM.
 */
async function readProgIdCommand(progId) {
  for (const root of ['HKCU\\Software\\Classes', 'HKLM\\SOFTWARE\\Classes']) {
    const stdout = await regQuery([`${root}\\${progId}\\shell\\open\\command`, '/ve']);
    if (stdout) {
      const match = stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im);
      if (match) return match[1].trim();
    }
  }
  return null;
}

/**
 * Is FATE the current handler for `.md`?
 *
 * Deliberately does NOT just compare the ProgId string against a constant. Our ProgId is the
 * generic "Markdown Document", which another application could plausibly register, so a name match
 * alone would report a false positive. Instead the ProgId is resolved to its open command and that
 * command is checked against this process's own executable. That answers the real question
 * ("would double-clicking a .md file launch *me*?") rather than a proxy for it.
 *
 * In development `process.execPath` is electron.exe, so the comparison falls back to the ProgId
 * hint; there is no packaged exe to match against yet.
 *
 * Returns `{ supported, isDefault, currentProgId, currentCommand }`. `supported: false` off Windows
 * so the renderer hides the control rather than offering something that cannot work.
 */
async function getDefaultAppStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, isDefault: false, currentProgId: null, currentCommand: null };
  }

  const progId = await readUserChoiceProgId('.md');
  if (!progId) {
    return { supported: true, isDefault: false, currentProgId: null, currentCommand: null };
  }

  const command = await readProgIdCommand(progId);
  let isDefault = false;

  if (command) {
    const ourExe = path.basename(process.execPath).toLowerCase();
    const cmd = command.toLowerCase();
    isDefault = isDev
      // Dev builds run through electron.exe, so matching on the exe name is meaningless here.
      ? progId === MD_PROG_ID_HINT
      // Match on the full path when we can, falling back to the executable name. Both are checked
      // because a per-user install and a per-machine install have different directories but the
      // same exe name.
      : cmd.includes(process.execPath.toLowerCase()) || cmd.includes(ourExe);
  }
  // No resolvable command => NOT default, regardless of what the ProgId is called.
  //
  // This used to fall back to `progId === MD_PROG_ID_HINT`, and that fallback was wrong in exactly
  // the case that matters. A broken install could leave UserChoice still naming "Markdown Document"
  // while the ProgId's command key had been deleted, so Windows fell back to another handler, but
  // FATE cheerfully reported "FATE currently opens .md files". A ProgId with nothing to run is not
  // a default; if the command cannot be resolved, the honest answer is no.

  return { supported: true, isDefault, currentProgId: progId, currentCommand: command };
}

/**
 * Open the Windows UI where the user can review or change the `.md` handler.
 *
 * ── Why this is not just a registry write ─────────────────────────────────────────────────────
 * Since Windows 10 the `UserChoice` key carries a per-user hash (visible in the registry as a
 * `Hash` value beside `ProgId`). Windows validates it, and any application that writes the key
 * itself is detected and reset (deliberately, so apps cannot silently hijack a file type). The
 * final confirmation has to come from a Windows-owned UI.
 *
 * ── Why NOT `rundll32 shell32.dll,OpenAs_RunDLL` ──────────────────────────────────────────────
 * 1.8.0 and 1.8.1 shelled out to that, on the theory that its "How do you want to open this file?"
 * dialog carries an "Always use this app" checkbox. On Windows 11 it does not: the only button is
 * **"Just once"**, so it can never actually set a default there. It merely looked like it worked.
 *
 * Worse, it is not even reliable as a picker: Windows suppresses the dialog entirely once the
 * extension has a confirmed `UserChoice`. So the moment FATE genuinely became the default, the
 * button silently did nothing at all: invoked correctly, valid file, rundll32 present, no dialog.
 * A control whose behaviour inverts once it succeeds is the wrong control.
 *
 * ── What this does instead ────────────────────────────────────────────────────────────────────
 * Deep-links into Settings, which always opens something and is the only surface that can actually
 * change a default on Windows 11. `registeredAppUser` jumps straight to FATE's own page, which works
 * because the installer now registers FATE under HKLM\SOFTWARE\RegisteredApplications with a
 * Capabilities key (see build/installer.nsh). Without that registration Windows ignores the
 * parameter, which is why earlier versions dumped the user on the full alphabetical list; the plain
 * page is kept as the fallback for exactly that case.
 */
async function requestDefaultAppAssociation() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };

  const candidates = [
    /*
     * FATE's own page in Default apps. The parameter matters: `registeredAppMachine` is for apps
     * registered under HKLM\SOFTWARE\RegisteredApplications (which is where the perMachine
     * installer writes ours); `registeredAppUser` is for HKCU registrations (which the runtime
     * self-heal writes). 1.10.0 passed only the User variant while the registration was
     * Machine-only, which is why the deep link dumped users on the full alphabetical list.
     * Both are tried; Windows ignores a parameter that doesn't match and just opens the list.
     */
    `ms-settings:defaultapps?registeredAppMachine=${encodeURIComponent(APP_TITLE)}`,
    `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP_TITLE)}`,
    // Fallback: the Default apps list. The user searches the type themselves.
    'ms-settings:defaultapps'
  ];

  for (const uri of candidates) {
    try {
      await shell.openExternal(uri);
      return { ok: true, via: uri.includes('?') ? 'app-page' : 'settings-list' };
    } catch {
      /* try the next one */
    }
  }

  // Never fail silently; the renderer surfaces this in the status bar.
  return { ok: false, error: 'Could not open Windows Settings' };
}

/**
 * Run a PowerShell script and resolve its stdout.
 *
 * Via a temp `.ps1` and `-File`, NOT `-Command` with an inline string: the association scripts
 * below need `Add-Type -MemberDefinition` here-strings, and a here-string's closing `'@` has to
 * start at column 0, which survives a file and does not survive being flattened into one argv
 * element. `-ExecutionPolicy Bypass` is required for the same reason (a `.ps1` is subject to
 * policy where `-Command` is not).
 *
 * `-WindowStyle Hidden` is belt to `windowsHide`'s braces. windowsHide alone is documented to be
 * enough, but a console window still flashes on some machines when the child is spawned from a
 * GUI process, which is the most likely cause of the "a PowerShell window blinks when I
 * double-click a .ps1" report, since the launch path runs one of these.
 */
let psScriptSeq = 0;
function runPowerShell(script, timeout = 60000) {
  return new Promise((resolve) => {
    const file = path.join(app.getPath('temp'), `fate-ps-${process.pid}-${psScriptSeq++}.ps1`);
    try {
      fs.writeFileSync(file, script, 'utf-8');
    } catch (e) {
      resolve({ ok: false, error: e.message, stdout: '' });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, timeout },
      (err, stdout) => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* temp dir cleanup will get it */
        }
        resolve({ ok: !err, error: err?.message, stdout: (stdout || '').trim() });
      }
    );
  });
}

/**
 * Shared PowerShell prelude: ask the SHELL what a file type opens with, rather than inferring it
 * from the registry.
 *
 * ── Why this replaced the registry heuristic in 1.12.0 ────────────────────────────────────────
 * The old counter walked the registry and applied the rules everyone believes Explorer uses:
 * UserChoice, else the `.ext` class default, else a sole OpenWithProgids registrant. Measured
 * against a real machine, rule 2 is simply FALSE on Windows 11: a class default written by an
 * application does not make it the handler. Worse, writing one SUPPRESSES rule 3, which does
 * work. So the old "claim" feature took 41 types that Explorer was happy to give FATE and left
 * them with no handler at all, while the counter reported them as won (68/86 against a true 29).
 *
 * `AssocQueryString(ASSOCSTR_EXECUTABLE, verb 'open')` is the API Explorer itself resolves through,
 * so there is nothing left to get wrong: it returns the exe that would actually launch, and
 * `OpenWith.exe` (the "How do you want to open this file?" picker) is the no-handler sentinel.
 *
 * Costs an `Add-Type` compile (~1s) on first use, which is why callers are on-demand only.
 */
const ASSOC_PRELUDE = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace FATE -Name Shell -MemberDefinition @'
[DllImport("shlwapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern uint AssocQueryString(int flags, int str, string pszAssoc, string pszExtra, System.Text.StringBuilder pszOut, ref uint pcchOut);
[DllImport("shell32.dll")]
public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
'@
function Get-Handler([string] $dotExt) {
  $sb = New-Object System.Text.StringBuilder 2048
  $n = [uint32] 2048
  # 2 = ASSOCSTR_EXECUTABLE. The 'open' verb is required; without it the call returns
  # ERROR_NO_ASSOCIATION even for types that plainly have a handler.
  $rc = [FATE.Shell]::AssocQueryString(0, 2, $dotExt, 'open', $sb, [ref] $n)
  if ($rc -ne 0) { return '' }
  return $sb.ToString()
}
function Test-Ours([string] $progId) {
  if (-not $progId) { return $false }
  return ($progId -eq 'Markdown Document') -or ($progId -like 'FATE.*')
}
`;

/** SHCNE_ASSOCCHANGED: tell Explorer the association map moved so icons and menus catch up. */
const ASSOC_NOTIFY_PS = `[FATE.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)`;

/**
 * Undo the damage 1.10/1.11 did, and keep `.bat`/`.cmd` out of FATE's hands. Runs on every
 * packaged launch (and on demand from Settings → Windows).
 *
 * Two repairs, both deliberately conservative; a type that currently works is never touched:
 *
 *  1. **The dead class defaults.** For any type that resolves to NOTHING while
 *     `HKCU\Software\Classes\.ext` names a FATE ProgId, that value is removed. It was never doing
 *     anything useful (see ASSOC_PRELUDE) and it actively blocks the sole-registrant fallback, so
 *     removing it can only improve the type: it either starts opening with FATE or stays unowned.
 *
 *  2. **`.bat` / `.cmd`.** Every trace of FATE is removed: the Open With entry (the thing that
 *     actually breaks these types; see PROTECTED_EXTENSIONS), the ProgId, the Capabilities entry,
 *     and any FATE `UserChoice`. Deleting a UserChoice is allowed where writing one is not. Its
 *     ACL denies SetValue, not Delete, which is how Windows itself resets a type.
 *
 *     LIMIT: this reaches HKCU only, because the app runs unelevated. The 1.11.5 installer wrote
 *     the same entries to HKLM, and those keep the type broken until they are gone. Removing them
 *     needs elevation, so it happens in the installer (RestoreCommandProcessorType in
 *     build/installer.nsh); upgrading to 1.12.0 is what completes the repair on a machine that
 *     had 1.11.5 installed per-machine.
 */
async function repairAssociations() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };

  const exe = process.execPath.replace(/'/g, "''");
  const list = (arr) => arr.map((e) => `'${e}'`).join(',');
  /*
   * Written into the PowerShell source verbatim, so single backslashes here. Two spellings on
   * purpose: the PowerShell registry PROVIDER needs the drive colon (`HKCU:\…`), reg.exe rejects
   * it and wants the bare hive name (`HKCU\…`).
   */
  const FILE_EXTS_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts';
  const FILE_EXTS_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts';

  const script = `${ASSOC_PRELUDE}
$exe = '${exe}'
$exeName = [System.IO.Path]::GetFileName($exe)
$fixed = @(); $restored = @()

function Test-Unowned([string] $handler) {
  return (-not $handler) -or ($handler -imatch 'OpenWith\\.exe$')
}
function Get-ClassDefault([string] $dotExt) {
  try { return (Get-ItemProperty "HKCU:\\Software\\Classes\\$dotExt" -ErrorAction Stop).'(default)' } catch { return $null }
}
function Remove-UserChoice([string] $dotExt) {
  # NOT reg.exe. It opens the target with KEY_ALL_ACCESS, and UserChoice carries a deny ACE on
  # KEY_SET_VALUE, SDDL (D;;DC;;;<user-sid>), so that open fails outright with Access Denied.
  # DELETING the key needs only DELETE, which the inherited full-control ACE does grant. Opening
  # the PARENT for write and removing the child through it asks for exactly that and no more.
  # This is the same reset Windows itself performs; only WRITING a UserChoice is protected.
  try {
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$dotExt", $true)
    if ($null -eq $parent) { return $false }
    $parent.DeleteSubKey('UserChoice', $false)
    $parent.Close()
    return $true
  } catch { return $false }
}

# ── 1. Class defaults that block the association they were meant to create ──────────────────
foreach ($e in @(${list(ASSOCIABLE_EXTENSIONS)})) {
  $d = ".$e"
  if (-not (Test-Unowned (Get-Handler $d))) { continue }   # working type: leave it alone
  if (Test-Ours (Get-ClassDefault $d)) {
    reg.exe delete "HKCU\\Software\\Classes\\$d" /ve /f > $null 2>&1
    $fixed += $e
  }
}

# ── 2. Give .bat / .cmd back to the command processor, permanently ──────────────────────────
foreach ($e in @(${list(PROTECTED_EXTENSIONS)})) {
  $d = ".$e"
  $uc = $null
  try { $uc = (Get-ItemProperty "${FILE_EXTS_PS}\\$d\\UserChoice" -ErrorAction Stop).ProgId } catch {}
  if ((Test-Ours $uc) -and (Remove-UserChoice $d)) { $restored += $e }
  if (Test-Ours (Get-ClassDefault $d)) { reg.exe delete "HKCU\\Software\\Classes\\$d" /ve /f > $null 2>&1 }
  reg.exe delete "HKCU\\Software\\Classes\\$d\\OpenWithProgids" /v "FATE.$e" /f > $null 2>&1
  reg.exe delete "HKCU\\Software\\Classes\\$d\\OpenWithProgids" /v "FATE.CodeFile" /f > $null 2>&1
  reg.exe delete "${FILE_EXTS_REG}\\$d\\OpenWithProgids" /v "FATE.$e" /f > $null 2>&1
  reg.exe delete "HKCU\\Software\\Classes\\FATE.$e" /f > $null 2>&1
  reg.exe delete "HKCU\\Software\\FATE\\Capabilities\\FileAssociations" /v "$d" /f > $null 2>&1
}

if ($fixed.Count -gt 0 -or $restored.Count -gt 0) { ${ASSOC_NOTIFY_PS} }
@{ fixed = @($fixed); restored = @($restored) } | ConvertTo-Json -Compress
`;

  const { ok, stdout, error } = await runPowerShell(script);
  if (!ok) return { ok: false, error };
  try {
    const parsed = JSON.parse(stdout || '{}');
    const fixed = [].concat(parsed.fixed || []);
    const restored = [].concat(parsed.restored || []);
    // The legacy bookkeeping described writes that never worked; once repaired it means nothing.
    if (fixed.length) store.set('claimedTypes', []);
    return { ok: true, fixed, restored };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Which of FATE's supported file types actually open with FATE.
 *
 * Asks the shell per extension (see ASSOC_PRELUDE) instead of reimplementing Explorer's
 * resolution order, because the registry-heuristic version this replaced was wrong in a way that
 * mattered: it counted FATE's own inert class-default writes as ownership and reported 68/86 on a
 * machine whose true figure was 29.
 *
 * `.bat`/`.cmd` are absent from the total by design; FATE will not take them (PROTECTED_EXTENSIONS).
 *
 * Returns { supported, total, ours, ownedExtensions, unowned, otherApp, repairable } where
 * `unowned` have no handler at all, `otherApp` belong to something else, and `repairable` is the
 * subset of `unowned` still carrying a FATE class default that repairAssociations() can clear.
 */
async function getAssociationCoverage() {
  if (process.platform !== 'win32') {
    return { supported: false, total: 0, ours: 0, ownedExtensions: [], unowned: [], otherApp: [], repairable: [] };
  }

  const exe = process.execPath.replace(/'/g, "''");
  const script = `${ASSOC_PRELUDE}
$exe = '${exe}'
$exeName = [System.IO.Path]::GetFileName($exe)
$owned = @(); $unowned = @(); $other = @(); $repairable = @()

foreach ($e in @(${ASSOCIABLE_EXTENSIONS.map((x) => `'${x}'`).join(',')})) {
  $d = ".$e"
  $h = Get-Handler $d
  if ((-not $h) -or ($h -imatch 'OpenWith\\.exe$')) {
    $unowned += $e
    $cd = $null
    try { $cd = (Get-ItemProperty "HKCU:\\Software\\Classes\\$d" -ErrorAction Stop).'(default)' } catch {}
    if (Test-Ours $cd) { $repairable += $e }
  }
  # Full path first (a per-user and a per-machine install share an exe name), then the name alone.
  elseif (($h -ieq $exe) -or ([System.IO.Path]::GetFileName($h) -ieq $exeName)) { $owned += $e }
  else { $other += $e }
}
@{ owned = @($owned); unowned = @($unowned); other = @($other); repairable = @($repairable) } | ConvertTo-Json -Compress
`;

  const total = ASSOCIABLE_EXTENSIONS.length;
  const { ok, stdout, error } = await runPowerShell(script);
  if (!ok) return { supported: true, total, ours: 0, ownedExtensions: [], unowned: [], otherApp: [], repairable: [], error };
  try {
    const p = JSON.parse(stdout || '{}');
    const ownedExtensions = [].concat(p.owned || []);
    return {
      supported: true,
      total,
      ours: ownedExtensions.length,
      ownedExtensions,
      unowned: [].concat(p.unowned || []),
      otherApp: [].concat(p.other || []),
      repairable: [].concat(p.repairable || []),
      protectedExtensions: PROTECTED_EXTENSIONS
    };
  } catch (e) {
    return { supported: true, total, ours: 0, ownedExtensions: [], unowned: [], otherApp: [], repairable: [], error: e.message };
  }
}

/**
 * Self-healing per-user registration, run at every packaged launch.
 *
 * Discovered the hard way: the installer's HKLM registration can vanish wholesale (an uninstall
 * that precedes a reinstall, upgrade races) and it also goes stale when the install location
 * changes (1.11.0 moved it). Rather than trusting a write that happened once at install time,
 * the app asserts its own registration under HKCU on launch: ProgId commands pointing at
 * process.execPath (always correct by construction), OpenWithProgids for every code type, and a
 * Capabilities + RegisteredApplications entry so FATE's Default-apps page exists even if HKLM is
 * gone. Per-user keys shadow HKLM, need no elevation, and cost one hidden `reg import`, skipped
 * when a stamp shows the current exe already registered.
 */
function ensureWindowsRegistration() {
  /*
   * app.isPackaged, NOT the NODE_ENV check: a production-mode dev run (`electron .` without
   * NODE_ENV) passes isDev but runs from node_modules' electron.exe, and self-healing from there
   * would register ProgIds pointing at the dev toolchain. Only a real installed build registers.
   */
  if (process.platform !== 'win32' || !app.isPackaged || isWindowsStore) return;

  const stampKey = 'registrationStamp';
  // The trailing number is the registration SCHEMA version. Bump it whenever the shape of the
  // .reg payload changes, so existing installs re-heal on update even at the same app version.
  const stamp = `${process.execPath}|${app.getVersion()}|4`;
  if (store.get(stampKey) === stamp) return;

  const exe = process.execPath.replace(/\\/g, '\\\\');
  // Per-type document icons ship in resources\fileicons (see scripts/generate-file-icons.mjs).
  const icoFor = (e) =>
    path.join(process.resourcesPath, 'fileicons', `${e}.ico`).replace(/\\/g, '\\\\');
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    // Legacy shared ProgId: kept registered (no Open-with listing) so UserChoice entries made on
    // 1.10/1.11 pre-icon installs keep resolving.
    '[HKEY_CURRENT_USER\\Software\\Classes\\FATE.CodeFile]',
    '@="Code File"',
    '"FriendlyTypeName"="Code File (FATE)"',
    '[HKEY_CURRENT_USER\\Software\\Classes\\FATE.CodeFile\\DefaultIcon]',
    `@="${exe},0"`,
    '[HKEY_CURRENT_USER\\Software\\Classes\\FATE.CodeFile\\shell\\open\\command]',
    `@="\\"${exe}\\" \\"%1\\""`,
    `[HKEY_CURRENT_USER\\Software\\Classes\\${MD_PROG_ID_HINT}\\shell\\open\\command]`,
    `@="\\"${exe}\\" \\"%1\\""`,
    '[HKEY_CURRENT_USER\\Software\\FATE\\Capabilities]',
    `"ApplicationName"="${APP_TITLE}"`,
    '"ApplicationDescription"="Formatted Article & Text Editor: a text and code editor with Markdown preview."',
    '[HKEY_CURRENT_USER\\Software\\FATE\\Capabilities\\FileAssociations]',
    ...MARKDOWN_EXTENSIONS.map((e) => `".${e}"="${MD_PROG_ID_HINT}"`),
    ...ASSOCIABLE_CODE_EXTENSIONS.map((e) => `".${e}"="FATE.${e}"`),
    '[HKEY_CURRENT_USER\\Software\\RegisteredApplications]',
    `"${APP_TITLE}"="Software\\\\FATE\\\\Capabilities"`,
    /*
     * "Edit in FATE" on the right-click menu for EVERY file, like Notepad++'s verb. A classic
     * shell verb lands in Windows 11's "Show more options" tier (the top-level modern menu needs
     * a packaged IExplorerCommand, which an NSIS install cannot ship).
     */
    '[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FATE.edit]',
    '@="Edit in FATE"',
    `"Icon"="${exe},0"`,
    '[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FATE.edit\\command]',
    `@="\\"${exe}\\" \\"%1\\""`,
    // One ProgId per code type, each with its own gilded extension icon.
    ...ASSOCIABLE_CODE_EXTENSIONS.flatMap((e) => [
      `[HKEY_CURRENT_USER\\Software\\Classes\\FATE.${e}]`,
      `@="${e.toUpperCase()} File (FATE)"`,
      `[HKEY_CURRENT_USER\\Software\\Classes\\FATE.${e}\\DefaultIcon]`,
      `@="${icoFor(e)}"`,
      `[HKEY_CURRENT_USER\\Software\\Classes\\FATE.${e}\\shell\\open\\command]`,
      `@="\\"${exe}\\" \\"%1\\""`,
      `[HKEY_CURRENT_USER\\Software\\Classes\\.${e}\\OpenWithProgids]`,
      `"FATE.${e}"=""`,
      // `=-` deletes the legacy value: one FATE entry in Open With, not two.
      `"${CODE_PROG_ID}"=-`
    ]),
    ''
  ];

  const regFile = path.join(app.getPath('temp'), `fate-registration-${process.pid}.reg`);
  try {
    fs.writeFileSync(regFile, lines.join('\r\n'), 'utf-8');
    execFile('reg', ['import', regFile], { windowsHide: true }, (err) => {
      try {
        fs.unlinkSync(regFile);
      } catch {
        /* temp dir cleanup will get it */
      }
      if (!err) store.set(stampKey, stamp);
      else console.error('Registration self-heal failed:', err.message);
    });
  } catch (e) {
    console.error('Registration self-heal failed:', e.message);
  }
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   PRINTING & PDF EXPORT
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ── Why printing was rebuilt in 1.8.0 ─────────────────────────────────────────────────────────
 * The renderer used to call `window.print()`, which hands off to the Windows print dialog. That
 * dialog renders "This app doesn't support print preview", because Electron ships Chromium *without*
 * the print-preview UI; there is no flag that turns it on. So the user got a printer picker and no
 * idea what would come out.
 *
 * The fix is to stop asking the OS to preview an app window and instead produce the artifact we
 * actually want: `webContents.printToPDF()` renders the document through the `@media print`
 * stylesheet into a real PDF. That PDF can then be
 *   - shown in a preview window (Chromium's built-in PDF viewer, which has genuine page-by-page
 *     preview, zoom, and its own print button), or
 *   - saved straight to disk as an export.
 *
 * Same renderer, same print CSS, both paths, so what you preview is what you get.
 */

/** Page geometry. Margins are in inches, which is what Electron's printToPDF expects. */
const PDF_MARGINS = { top: 0.6, bottom: 0.6, left: 0.65, right: 0.65 };

/**
 * Header and footer for exported/printed pages.
 *
 * Chromium substitutes the `title`, `pageNumber`, `totalPages`, `date` and `url` classes. The
 * templates are deliberately plain and grey. This is page furniture, not a brand surface, and it
 * has to survive being printed in black and white on someone else's printer.
 *
 * The inline font-size is required: Chromium renders these templates at a default of ~1px otherwise.
 */
function headerTemplate(docName) {
  const safe = String(docName || '').replace(/[<>&]/g, '');
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:8px;color:#666;width:100%;padding:0 0.65in;
    display:flex;justify-content:space-between;align-items:center;">
    <span style="letter-spacing:0.08em;text-transform:uppercase;">${safe}</span>
    <span class="date" style="letter-spacing:0.04em;"></span>
  </div>`;
}

const FOOTER_TEMPLATE = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:8px;color:#888;width:100%;
  padding:0 0.65in;display:flex;justify-content:space-between;align-items:center;">
  <span style="letter-spacing:0.1em;text-transform:uppercase;">FATE</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

/**
 * Render the currently open document to PDF bytes.
 *
 * Options that matter and why:
 *   printBackground: true      See the long note below. Set true DELIBERATELY.
 *   generateDocumentOutline    Turns the document's headings into real PDF bookmarks. For a
 *                                Markdown viewer whose whole sidebar is a table of contents, this
 *                                is the single highest-value option available.
 *   generateTaggedPDF          Emits structure tags, so screen readers can navigate the export.
 *   preferCSSPageSize: false   The requested pageSize wins over any `@page` rule, so the Settings
 *                                choice is authoritative.
 *
 * ── Why printBackground is true ───────────────────────────────────────────────────────────────
 * It was false in 1.8.0, on the reasoning that the print stylesheet forces white paper anyway. That
 * reasoning was wrong, and the flag was doing nothing: the stylesheet also sets
 * `print-color-adjust: exact` on the document container, which OVERRIDES printBackground and forces
 * backgrounds to paint regardless. So `false` bought no safety while quietly implying it did, and
 * the dark table-row backgrounds the stylesheet had failed to reset went to paper.
 *
 * Setting it true makes the actual behaviour explicit and leaves the print stylesheet as the single
 * source of truth for print appearance. The stylesheet now zeroes every background inside
 * `.markdown-body` and adds back only light values, so backgrounds printing is wanted: light zebra
 * striping on tables, grey code blocks, a tinted blockquote, all of which aid readability on paper.
 */
async function renderDocumentPdf({ landscape = false, pageSize = 'Letter', docName = 'Document' } = {}) {
  if (!mainWindow) throw new Error('no window to print from');
  return mainWindow.webContents.printToPDF({
    landscape,
    pageSize,
    margins: PDF_MARGINS,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: headerTemplate(docName),
    footerTemplate: FOOTER_TEMPLATE,
    generateDocumentOutline: true,
    generateTaggedPDF: true,
    preferCSSPageSize: false
  });
}

/** Filename-safe version of a document name, for the default export name. */
function safeFileStem(name) {
  return (
    String(name || 'document')
      // Strip the final extension whatever it is: "script.ps1" should export as "script.pdf",
      // not "script.ps1.pdf". (Was markdown-only before code files existed.)
      .replace(/\.[a-z0-9]{1,10}$/i, '')
      // Characters Windows refuses in file names, and control characters (\p{Cc}: C0, DEL, C1).
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'document'
  );
}

let previewWindow = null;

/**
 * Show a print preview.
 *
 * Renders the document to a temp PDF and opens it in a child window with `plugins: true`, which is
 * what enables Chromium's bundled PDF viewer. That viewer provides the real preview the OS dialog
 * could not: actual paginated output, zoom, page navigation, and a print button that prints the
 * *PDF*, so the printer receives exactly what is on screen.
 *
 * A single preview window is reused; printing twice should not litter the desktop with windows.
 */
async function showPrintPreview(docName) {
  const pdf = await renderDocumentPdf({
    docName,
    pageSize: store.get('printPageSize') || 'Letter',
    landscape: !!store.get('printLandscape')
  });

  const file = path.join(app.getPath('temp'), `FATE-preview-${process.pid}.pdf`);
  fs.writeFileSync(file, pdf);

  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.loadURL(pathToFileURL(file).toString());
    previewWindow.focus();
    return { ok: true, reused: true };
  }

  previewWindow = new BrowserWindow({
    width: 940,
    height: 1000,
    minWidth: 480,
    minHeight: 400,
    parent: mainWindow,
    title: `${APP_TITLE}: Print preview`,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      // Required for Chromium's built-in PDF viewer. No preload and no node here; this window
      // only ever displays a PDF we generated ourselves.
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  /*
   * The preview must not become a browser. Nothing in a PDF should be able to navigate it: a
   * link clicked in Chromium's PDF viewer navigates the WINDOW (only new-window links reached the
   * handler that used to be the sole guard here), so both routes go through the same policy as
   * the main window's links, confirmation for web links included.
   */
  const previewUrl = pathToFileURL(file).toString();
  previewWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, previewWindow);
    return { action: 'deny' };
  });
  previewWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, { entryUrl: previewUrl })) return;
    event.preventDefault();
    openExternalLink(url, previewWindow);
  });
  previewWindow.setMenu(Menu.buildFromTemplate(appMenu.buildPreviewMenuTemplate()));

  previewWindow.on('closed', () => {
    previewWindow = null;
    // Best-effort cleanup; a leftover temp PDF is harmless but there is no reason to keep it.
    try {
      fs.unlinkSync(file);
    } catch {
      /* the viewer may still hold a handle; Windows will reclaim it with the temp dir */
    }
  });

  /*
   * Fallback if the embedded viewer cannot display the PDF.
   *
   * `plugins: true` enables Chromium's bundled PDF viewer, but that depends on the Electron build
   * actually shipping it. If it is missing, `loadURL` on a PDF fails rather than rendering, which
   * would leave the user staring at an empty window with no way forward. Handing the file to the
   * OS default PDF application is a worse preview but an infinitely better failure mode than a
   * blank window.
   */
  previewWindow.webContents.once('did-fail-load', (_e, errorCode, errorDescription) => {
    console.error(`Print preview failed to render PDF (${errorCode}: ${errorDescription}); ` +
                  'falling back to the system PDF handler.');
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
    previewWindow = null;
    shell.openPath(file);
  });

  previewWindow.loadURL(previewUrl);
  return { ok: true, reused: false };
}

/** Save the document as a PDF the user chooses the location for. */
async function exportPdf(docName) {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export as PDF',
    defaultPath: `${safeFileStem(docName)}.pdf`,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const pdf = await renderDocumentPdf({
    docName,
    pageSize: store.get('printPageSize') || 'Letter',
    landscape: !!store.get('printLandscape')
  });
  fs.writeFileSync(filePath, pdf);
  return { ok: true, filePath };
}

/*
 * fate-local:// serves the images a Markdown document references from disk (handler in
 * app.whenReady). Its privileges are what <img> needs and nothing more:
 *   standard   real URL parsing (host, relative resolution); see the `local` host note at the
 *              handler for why that matters.
 *   secure     counts as a secure origin, so the images are never mixed content.
 * Dropped in 1.14.0: `supportFetchAPI`, which let any script in the page fetch() and READ any
 * local file through this scheme; `bypassCSP`, since the page's CSP lists fate-local: in img-src;
 * and `stream`, which is for media range requests, not images.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'fate-local', privileges: { secure: true, standard: true } }
]);

const isDev = process.env.NODE_ENV === 'development';

/**
 * True when running as the Microsoft Store (AppX) package. Electron sets this for Windows Store
 * builds. It changes two things:
 *   - Updates: electron-updater cannot update an AppX (the Store owns that pipeline). The updater
 *     is never started, and the UI routes "check for updates" to the Store's Downloads & updates
 *     page instead of pretending a check happened.
 *   - Registration: the AppX manifest declares file associations; the registry self-heal below is
 *     skipped (AppX registry writes are virtualised anyway).
 */
const isWindowsStore = process.windowsStore === true;

/**
 * Who delivers updates for THIS install.
 *
 * electron-updater is right for exactly two packages, the NSIS installer on Windows and the
 * AppImage on Linux, because nothing else owns them. Every other channel has an owner that will
 * update FATE on its own schedule, and an in-app updater would fight it: the Microsoft Store,
 * Flathub (FLATPAK_ID is set inside the sandbox), the Snap Store (SNAP), and the .deb/.rpm, which
 * register FATE's own apt/dnf repository in their post-install script so the system package
 * manager takes over (electron-builder writes resources/package-type for those two), and the AUR
 * package, which rewrites that marker to "pacman". For a
 * managed install the updater never starts and the status-bar button says who is in charge.
 */
function detectUpdateSource() {
  if (isWindowsStore) return { managed: true, kind: 'windows-store', label: 'the Microsoft Store' };
  if (process.env.FLATPAK_ID) return { managed: true, kind: 'flatpak', label: 'Flathub' };
  if (process.env.SNAP) return { managed: true, kind: 'snap', label: 'the Snap Store' };
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    try {
      const kind = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
      if (kind === 'deb') return { managed: true, kind, label: 'apt' };
      if (kind === 'rpm') return { managed: true, kind, label: 'dnf' };
      // Written by the AUR package (aur/PKGBUILD), which repackages the .deb.
      if (kind === 'pacman') return { managed: true, kind, label: 'pacman' };
      if (kind) return { managed: true, kind, label: 'your package manager' };
    } catch {
      // No package-type marker: an unpacked dev build or an AppImage, so self-updating.
    }
  }
  return { managed: false, kind: process.platform === 'linux' ? 'appimage' : 'nsis', label: null };
}
const updateSource = detectUpdateSource();

let mainWindow;

/*
 * ── Open documents ────────────────────────────────────────────────────────────────────────────
 * The file I/O lives in small modules beside this one, each free of Electron and tested under
 * plain node (test/): fileFormat.cjs (encodings, byte-order marks, line endings), textFiles.cjs
 * (async reads, atomic saves), fileWatch.cjs (live reload), backups.cjs (hot exit) and
 * rendererSettings.cjs (the settings keys the renderer may touch). Required here, beside the code
 * that uses them.
 */
const { ENCODINGS, ENCODING_LABELS, defaultFormat, encode, resolveFormat, sameFormat, normalizeText, textDigest } = require('./fileFormat.cjs');
const { readTextFile, writeFileAtomic } = require('./textFiles.cjs');
const { createFileWatcher } = require('./fileWatch.cjs');
const { createBackupStore } = require('./backups.cjs');
const { isRendererSettingKey, checkRendererSetting } = require('./rendererSettings.cjs');

/*
 * Since tabs (1.10.0) any number of files can be open at once, so all of this is per path, keyed
 * by watchKey():
 *
 *   fileFormats      path → the file's format on disk, { encoding, bom, eol } (fileFormat.cjs).
 *                    Recorded on open, on every save and on every reload; dropped when the tab
 *                    closes. A save that names no format writes this one, which is what keeps a
 *                    CRLF or UTF-16 file that way. Doubles as the list of paths the renderer may
 *                    save to: see isOpenPath.
 *   knownText        path → digest of the text the renderer last received for the file, or last
 *                    saved to it. Saving fires the same watch events an external edit does, and
 *                    Windows fires them for Defender scans and indexing too; a reload whose text
 *                    matches is not a change and is not sent. (This was lastSavedByApp, which knew
 *                    only FATE's own saves and compared raw text, so a CRLF file reloaded on every
 *                    stray event: its \r\n text never equalled the editor's \n text.) A digest,
 *                    so a 25 MB log is not held a second time.
 *   forcedEncodings  path → the encoding picked with Reopen with encoding. Reloads keep decoding
 *                    with it; Windows-1252 text that happens to be valid UTF-8 would otherwise
 *                    flip back to UTF-8 at the next watch event.
 */
const fileFormats = new Map();
const knownText = new Map();
const forcedEncodings = new Map();

/**
 * The comparable key for a path, used for the per-path maps, recents dedupe and tab dedupe.
 * Windows and (by default) macOS compare paths case-insensitively; Linux does not, where
 * `Notes.md` and `notes.md` are two files and folding case would give them one watcher.
 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';
function watchKey(filePath) {
  const normalized = path.normalize(filePath || '');
  return CASE_INSENSITIVE_PATHS ? normalized.toLowerCase() : normalized;
}

/**
 * May the renderer save to (or reopen) this path? Only when FATE opened it, by any route, or the
 * user chose it in Save As, and its tab is still open. Up to 1.13.4 save-file wrote wherever it
 * was told, which a renderer compromised through a document could have used to drop a script
 * into the Startup folder.
 */
function isOpenPath(filePath) {
  return typeof filePath === 'string' && filePath !== '' && fileFormats.has(watchKey(filePath));
}

/**
 * Read a document the way its tab expects: in the user's forced encoding if there is one (back to
 * detection if the file no longer decodes that way) and, for a file without a line break, with
 * the line ending it already had rather than the platform's.
 */
async function readDocument(filePath) {
  const key = watchKey(filePath);
  const opts = { maxBytes: MAX_FILE_BYTES, defaultEol: fileFormats.get(key)?.eol };
  const forced = forcedEncodings.get(key);
  if (forced) {
    try {
      return await readTextFile(filePath, { ...opts, forcedEncoding: forced });
    } catch (err) {
      if (err.code !== 'INVALID' && err.code !== 'BINARY') throw err;
      forcedEncodings.delete(key);
    }
  }
  return readTextFile(filePath, opts);
}

/**
 * The format to record for text just read. Detection is ambiguous in a way that must not flip a
 * file's format back and forth: plain ASCII reads as UTF-8 whatever it was saved as. When the
 * recorded format still produces exactly these bytes, it stays.
 */
function adoptFormat(key, doc) {
  const recorded = fileFormats.get(key);
  if (!recorded || sameFormat(recorded, doc.format)) return doc.format;
  try {
    if (encode(doc.text, recorded).equals(doc.bytes)) return recorded;
  } catch {
    /* the recorded format cannot even hold this text */
  }
  return doc.format;
}

/**
 * Live reload, one watcher per open file (fileWatch.cjs): bursts coalesced, files replaced by
 * atomic saves followed, deleted files retried and reported if they stay gone, and only the
 * newest read ever delivered.
 */
const fileWatcher = createFileWatcher({
  keyOf: watchKey,
  read: readDocument,
  onRead: (filePath, doc) => {
    const key = watchKey(filePath);
    if (!fileFormats.has(key)) return; // the tab closed meanwhile
    const format = adoptFormat(key, doc);
    const digest = textDigest(doc.text);
    // Our own save landing, or a scan or indexer touching the file: not a change.
    if (digest === knownText.get(key) && sameFormat(format, fileFormats.get(key))) return;
    fileFormats.set(key, format);
    knownText.set(key, digest);
    /*
     * The path rides along so the renderer can route the update to the right tab; the format,
     * because it can change on its own (a CRLF → LF conversion arrives with the text unchanged).
     */
    if (mainWindow) mainWindow.webContents.send('file-changed', doc.text, filePath, { format });
  },
  onDeleted: (filePath) => {
    if (mainWindow && isOpenPath(filePath)) mainWindow.webContents.send('file-deleted', filePath);
  },
  onError: (filePath, err) => console.error(`Live reload of ${filePath} failed:`, err.message)
});

/**
 * Whether ANY open tab holds unsaved edits. Mirrored over the 'set-edited' channel on every
 * aggregate transition, so the window-close guard below can ask before discarding them.
 */
let documentEdited = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Below roughly this size the two-column home layout has nowhere left to go and the viewer
    // header starts colliding with itself. The layout is responsive down to here and no further,
    // so the window simply refuses to get smaller rather than degrading into overlap.
    minWidth: 680,
    minHeight: 520,
    title: APP_TITLE,
    backgroundColor: '#070b1a', // avoids a white flash before the renderer paints
    /*
     * Linux only: Windows takes the window icon from the exe's resource and macOS from the
     * bundle, but on X11/Wayland the window's own icon (taskbar, alt-tab, dock) comes from this
     * option; without it every Electron app wears the stock Electron atom. Vite copies
     * public/favicon.png (a 256px square render of the app master) into dist/, which is shipped
     * in every package, so the same file serves dev and packaged builds.
     */
    ...(process.platform === 'linux' ? { icon: path.join(__dirname, '..', 'dist', 'favicon.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      /*
       * Always true: the `spellcheck` SETTING is applied to the session (see electron/spellcheck.cjs,
       * which also explains why this flag cannot be what turns it off). A window created with
       * false never marks misspellings, even once the session is enabled, so the setting could
       * only take effect after a restart.
       */
      spellcheck: true
    },
    autoHideMenuBar: true
  });

  /*
   * Don't let the window close over unsaved edits.
   *
   * The main process knows only THAT something is dirty (the renderer mirrors an aggregate flag
   * over 'set-edited'); it cannot save, because the buffers live in the renderer's CodeMirror
   * instances. So it vetoes the close once and hands the flow over: the renderer walks its dirty
   * tabs, offering Save / Don't save / Cancel per tab, and calls back on 'confirmed-close'.
   *
   * Before 1.12.0 this was a single "Discard changes and close?", and the only way to keep your work
   * was to cancel, close the dialog, and save by hand.
   *
   * `closeConfirmed` is what lets the second close() through; this handler runs again for it. The
   * timeout is the escape hatch for a renderer that never answers (mid-crash, or a stuck dialog);
   * without it the window would be unclosable.
   *
   * `closeWalkDone` (the user answered the walk) and `closing` (a close is under way) are for the
   * renderer's beforeunload guard; see 'will-prevent-unload' below.
   */
  let closeConfirmed = false;
  let closeWalkDone = false;
  let closing = false;
  let closeHandoffTimer = null;
  mainWindow.on('close', (e) => {
    if (closeConfirmed || !documentEdited) {
      closing = true;
      return;
    }
    e.preventDefault();
    clearTimeout(closeHandoffTimer);
    closeHandoffTimer = setTimeout(() => {
      closeConfirmed = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 60000);
    mainWindow.webContents.send('request-close');
  });

  /** The renderer finished its save-or-discard walk. `proceed: false` means the user cancelled. */
  ipcMain.removeAllListeners('confirmed-close'); // createWindow can run again (macOS 'activate')
  ipcMain.on('confirmed-close', (event, proceed) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return;
    clearTimeout(closeHandoffTimer);
    if (!proceed) return;
    closeConfirmed = true;
    closeWalkDone = true;
    documentEdited = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  /*
   * The renderer's beforeunload guard asked to keep the page: Chromium would show its own
   * "Leave site?" box, which Electron replaces with this event. Without a handler the unload is
   * simply cancelled, so a reload (DevTools, a dev-server restart) silently does nothing.
   *
   * After the close walk the user has already said what to do with every dirty tab, so the close
   * goes ahead without asking twice. Anything else asks, and must ask synchronously: the answer is
   * read when this handler returns. The wording follows what is being lost: a window closing
   * without the walk (the 60-second escape hatch, or a close that raced the renderer's dirty
   * flag), or a reload, which is the only other way this page unloads now that navigation is
   * locked to the app's own URL and the menu has no Reload.
   */
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const wasClosing = closing;
    closing = false;
    if (closeWalkDone) {
      event.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: wasClosing ? 'Discard unsaved changes and close?' : 'Discard unsaved changes and reload?',
      detail: 'Your edits have not been saved.'
    });
    if (choice === 0) event.preventDefault();
    else closeConfirmed = false;
  });

  /*
   * Right-click menu. Electron ships none, so right-clicking did nothing anywhere in FATE: no Copy
   * in the reading view, no Cut or Paste in the editor. The roles run Chromium's own editing
   * commands, so Copy fires the same 'copy' event as Ctrl+C (the preview's clean copy still
   * applies; see src/previewClipboard.js), and the edit flags grey out whatever doesn't apply where
   * the click landed. No Undo/Redo: CodeMirror keeps its own history, which those would bypass.
   *
   * On a misspelled word (only while the spellcheck setting is on) the dictionary's suggestions
   * come first, as in every editor: a click replaces the word in place, through the same editing
   * command a typed correction would use, so CodeMirror sees an ordinary edit (and can undo it).
   */
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { editFlags, isEditable, selectionText, linkURL, misspelledWord, dictionarySuggestions } = params;
    const groups = [];
    if (misspelledWord) {
      const wc = mainWindow.webContents;
      const suggestions = (dictionarySuggestions || []).slice(0, 8).map((word) => ({
        label: appMenu.escapeMenuLabel(word),
        click: () => wc.replaceMisspelling(word)
      }));
      groups.push([
        ...(suggestions.length ? suggestions : [{ label: 'No Spelling Suggestions', enabled: false }]),
        {
          label: 'Add to Dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(misspelledWord)
        }
      ]);
    }
    if (/^https?:/i.test(linkURL)) {
      groups.push([{ label: 'Copy Link Address', click: () => clipboard.writeText(linkURL) }]);
    }
    if (isEditable) {
      groups.push(
        [
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste }
        ],
        [{ role: 'selectAll', enabled: editFlags.canSelectAll }]
      );
    } else if (selectionText.trim()) {
      groups.push([{ role: 'copy' }]);
    }
    if (groups.length === 0) return;
    const template = groups.flatMap((group, i) => (i ? [{ type: 'separator' }, ...group] : group));
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  /*
   * SECURITY: the window never becomes a browser. New-window requests (target=_blank links,
   * window.open) and navigations both go through openExternalLink: web links after the user
   * confirms (until 1.13.4 a target=_blank link skipped the confirmation a plain click got), mail
   * links straight to the mail client, everything else refused.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, mainWindow);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    /*
     * The window may only ever navigate to ITSELF: its exact entry document (dev: the Vite
     * server). Up to 1.13.4 this allowed anything under dist/, so a relative link in a document
     * (`[x](CONTRIBUTING.md)` resolves against the PAGE, to dist/CONTRIBUTING.md) replaced the
     * whole app with an error page and every unsaved edit with it; see isAllowedNavigation.
     * Before that it allowed any file:// URL, and a file dropped outside a drop handler navigated
     * the app to the file. The renderer handles link clicks and drops itself; this is the second
     * line of defence.
     */
    if (isAllowedNavigation(url, APP_ENTRY)) return;
    event.preventDefault();
    openExternalLink(url, mainWindow);
  });

  if (isDev) {
    mainWindow.loadURL(APP_ENTRY.devServerUrl);
  } else {
    mainWindow.loadFile(APP_ENTRY_FILE);
  }

  /*
   * 'app-ready': the renderer is listening for 'open-file' from here on. Open the launch
   * arguments (once per run, not again after a reload), then any command lines second instances
   * handed over while it was loading. A reload makes the page deaf again until it re-announces.
   */
  rendererReady = false;
  let launchArgsOpened = false;
  ipcMain.removeAllListeners('app-ready'); // createWindow can run again (macOS 'activate')
  ipcMain.on('app-ready', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return;
    rendererReady = true;
    if (!launchArgsOpened) {
      launchArgsOpened = true;
      handleArgs(process.argv, process.cwd());
    }
    for (const { argv, cwd } of pendingSecondInstanceArgs.splice(0)) handleArgs(argv, cwd);
  });
  // 'did-navigate', not 'did-start-navigation': the latter also fires for the navigations
  // will-navigate then refuses, and the page that stays is still listening.
  mainWindow.webContents.on('did-navigate', () => {
    rendererReady = false;
  });

  // The page's renderer usually starts while the spellcheck dictionary is still loading, and then
  // never receives it; re-send it now that the page is up (see electron/spellcheck.cjs).
  mainWindow.webContents.on('did-finish-load', () => {
    if (spellcheck) spellcheck.refresh();
  });
}

/*
 * ── Where the main window may go ──────────────────────────────────────────────────────────────
 * Its own entry document and nothing else (see will-navigate above).
 */
const APP_ENTRY_FILE = path.join(__dirname, '..', 'dist', 'index.html');
const APP_ENTRY = isDev
  ? { devServerUrl: 'http://localhost:5173' }
  : { entryUrl: pathToFileURL(APP_ENTRY_FILE).toString() };

/**
 * Hand a link to the operating system, under the one policy every route shares: the main
 * window's navigations and new-window requests, the print preview's, and the renderer's
 * 'open-external' (link clicks in the preview).
 *
 *   http(s)   after the confirmation dialog: a document's link text can say anything, and this
 *             shows the address that will actually open.
 *   mailto:   straight to the mail client, which only opens a compose window.
 *   other     refused: file: would open or RUN the target, custom schemes start other apps with
 *             arguments the document chose (see classifyExternalUrl).
 *
 * Resolves { ok: true } once handed over, else { ok: false, reason: 'refused' | 'canceled' |
 * 'pending' | 'failed' }. 'pending': the same link is already waiting on its dialog, so a
 * double-click does not stack two.
 */
const pendingLinkPrompts = new Set();
async function openExternalLink(rawUrl, parentWindow) {
  const link = classifyExternalUrl(rawUrl);
  if (!link) return { ok: false, reason: 'refused' };

  if (link.kind === 'web') {
    if (pendingLinkPrompts.has(link.url)) return { ok: false, reason: 'pending' };
    pendingLinkPrompts.add(link.url);
    try {
      // A runaway URL still has to fit on screen; the browser gets the whole thing.
      const shown = link.url.length > 600 ? `${link.url.slice(0, 600)}…` : link.url;
      const options = {
        type: 'warning',
        buttons: ['Cancel', 'Open Browser'],
        defaultId: 1,
        cancelId: 0,
        title: 'External Link',
        message: `You are about to open an external link:\n${shown}\n\nDo you want to continue?`
      };
      const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response !== 1) return { ok: false, reason: 'canceled' };
    } finally {
      pendingLinkPrompts.delete(link.url);
    }
  }

  try {
    await shell.openExternal(link.url);
    return { ok: true };
  } catch (err) {
    console.error('Could not open link:', err.message);
    return { ok: false, reason: 'failed' };
  }
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   APPLICATION SHELL
   The application menu, spellcheck, "check for updates", and the IPC the window chrome uses
   (links, tab menu, file-manager reveal). Started once from app.whenReady, before the window.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The renderer's shortcut bindings as 'update-menu' last reported them. Labels only. */
let menuShortcuts = {};
/** The recents list 'fate-recents-changed' last carried ([{ path, openedAt }]); null: read the store. */
let menuRecents = null;
let menuRebuildTimer = null;
/** { set(enabled), refresh(), isEnabled() } from electron/spellcheck.cjs, once startAppShell has run. */
let spellcheck = null;

/**
 * (Re)build the application menu (see electron/appMenu.cjs) from the current bindings and recent
 * files: the list 'fate-recents-changed' last carried, or the store's. Neither is checked for
 * existence here: a stat per entry on every rebuild is exactly what freezes the main thread when
 * one of them is on a disconnected network drive. Open Recent checks the one file clicked.
 *
 * Menu.setApplicationMenu re-menus EVERY open window, so the print preview gets its own back.
 */
function installAppMenu() {
  clearTimeout(menuRebuildTimer);
  menuRebuildTimer = null;
  const template = appMenu.buildAppMenuTemplate(
    {
      shortcuts: menuShortcuts,
      recentFiles: (menuRecents || store.get('recentFiles') || []).map((entry) => entry && entry.path),
      isPackaged: app.isPackaged,
      platform: process.platform,
      homeDir: app.getPath('home')
    },
    {
      command: sendMenuCommand,
      openRecent: openRecentFromMenu,
      clearRecent: clearRecentFromMenu,
      checkForUpdates: checkForUpdatesNow,
      openUrl: (url) => shell.openExternal(url).catch(() => {})
    }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.setMenu(Menu.buildFromTemplate(appMenu.buildPreviewMenuTemplate()));
  }
}

/** Coalesces bursts (a session restore records every file it opens) into one rebuild. */
function scheduleAppMenuRebuild() {
  if (!menuRebuildTimer) menuRebuildTimer = setTimeout(installAppMenu, 50);
}

/** A menu item the renderer implements; the ids are listed in preload.cjs (onMenuCommand). */
function sendMenuCommand(id) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-command', id);
}

/**
 * File → Open Recent. The home screen greys out a recent file that has gone; a menu cannot, so a
 * click on one says so. openRecentFile (the home screen's own open) has already dropped it from the
 * list by then. Any other failure (permissions, snap confinement) openAndWatchFile has explained.
 */
async function openRecentFromMenu(filePath) {
  const result = await openRecentFile(filePath);
  if (result.reason !== 'missing') return;
  const options = {
    type: 'info',
    title: 'File not found',
    message: `Can't open ${path.basename(filePath)}: it was moved or deleted.`,
    detail: filePath
  };
  const shown = mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
  shown.catch(() => {});
}

/**
 * File → Open Recent → Clear Recently Opened: the same clear as the home screen's (the Windows Jump
 * List goes too). The home screen's list refreshes the next time it is shown.
 */
function clearRecentFromMenu() {
  clearRecentFiles();
}

function sendUpdateMessage(message, action = null) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-message', message, action);
}

/**
 * "Check for updates": the status-bar button and the palette (over 'check-for-updates') and
 * Help → Check for Updates. The answer arrives through the autoUpdater events, which post to the
 * status bar. The promises are caught (M13): electron-updater emits 'error' and THEN rejects, so
 * an offline check left an unhandled rejection behind; the download it starts rejects the same way.
 */
function checkForUpdatesNow() {
  /*
   * Store builds: electron-updater cannot update an AppX; the Store owns that pipeline, and
   * the previous behaviour ("Checking for updates…" followed by silence or an error) looked
   * broken because it was. Route to the Store's own updates page instead.
   */
  if (isWindowsStore) {
    shell.openExternal('ms-windows-store://downloadsandupdates').catch(() => {});
    return;
  }
  // Flatpak / Snap / apt / dnf own updates for this install (see detectUpdateSource). The
  // button still does something useful: it shows what the newest release contains.
  if (updateSource.managed) {
    shell.openExternal('https://github.com/VagueDustin/FATE/releases/latest').catch(() => {});
    return;
  }
  // Both of these used to do nothing at all, silently, which read as a broken button.
  if (isDev || !app.isPackaged) {
    sendUpdateMessage('Update checks run only in installed builds.');
    return;
  }
  if (!store.get('autoUpdatesEnabled')) {
    sendUpdateMessage('Automatic updates are off. Turn them on in Settings to check for updates.');
    return;
  }
  autoUpdater
    .checkForUpdates()
    .then((result) => result?.downloadPromise)
    .catch(() => {});
}

/** Everything in this section that has to exist before the window does. */
function startAppShell() {
  // Before any window: the language list decides whether a dictionary download starts at all.
  spellcheck = createSpellcheckController(session.defaultSession, {
    enabled: resolveSpellcheckSetting(store.get('spellcheck'), process.platform),
    preferredLanguages: [app.getLocale(), ...app.getPreferredSystemLanguages()],
    platform: process.platform,
    warn: (message) => console.warn(message)
  });

  installAppMenu();
  // The file I/O code emits this whenever the recent-files list changes, with the new list.
  app.on('fate-recents-changed', (list) => {
    menuRecents = Array.isArray(list) ? list : null;
    scheduleAppMenuRebuild();
  });

  /** The renderer's current bindings, for the menu's shortcut labels. Sent on load and on rebinds. */
  ipcMain.on('update-menu', (event, state) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const next = appMenu.sanitizeMenuShortcuts(state && state.shortcuts);
    if (JSON.stringify(next) === JSON.stringify(menuShortcuts)) return;
    menuShortcuts = next;
    scheduleAppMenuRebuild();
  });

  /** Settings → spellcheck. The renderer stores the choice itself (store.set('spellcheck')). */
  ipcMain.handle('set-spellcheck', (_event, enabled) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Spellcheck can only be on or off' };
    spellcheck.set(enabled);
    return { ok: true, enabled };
  });

  /** Link clicks in the preview: the same policy as a navigation. See openExternalLink. */
  ipcMain.handle('open-external', (event, url) => openExternalLink(url, BrowserWindow.fromWebContents(event.sender)));

  /**
   * Tab menu → Open Containing Folder. Only a file FATE has open (isOpenPath), and only while it is
   * an existing regular file: this hands the path to the file manager, and the renderer is the one
   * asking.
   */
  ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
      return { ok: false, error: 'Not a file path' };
    }
    const name = path.basename(filePath);
    if (!isOpenPath(filePath)) return { ok: false, error: `Can't show ${name}: it isn't open in FATE.` };
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return { ok: false, error: `Can't show ${name}: it is not a file.` };
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return { ok: false, error: `Can't show ${name}: it was moved or deleted.` };
      }
      return { ok: false, error: describeFsError(err, filePath, 'open').short };
    }
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  /**
   * A tab's right-click menu. Resolves the chosen action ('copyPath', 'reveal', 'close',
   * 'closeOthers', 'closeRight') or null when dismissed; the renderer carries it out. A chosen
   * item's click runs before the menu's close callback, and setImmediate keeps it that way even
   * if a platform delivered them in the other order.
   */
  ipcMain.handle('show-tab-context-menu', (event, info) =>
    new Promise((resolve) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        resolve(action);
      };
      const hasPath = !!info && typeof info.path === 'string' && info.path !== '';
      const menu = Menu.buildFromTemplate(appMenu.buildTabMenuTemplate({ hasPath }, (action) => () => finish(action)));
      menu.popup({ window: win, callback: () => setImmediate(() => finish(null)) });
    })
  );

  // Temp files a crashed run left behind (tempCleanup.cjs). Later, off the startup path.
  setTimeout(() => removeStaleTempFiles(app.getPath('temp')), 10000);
}

/**
 * Stop tracking a path: its tab closed, or Save As moved the tab elsewhere. The watcher goes, and
 * so does the path's place among the files the renderer may save to.
 */
function forgetPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return;
  const key = watchKey(filePath);
  fileWatcher.unwatch(filePath);
  fileFormats.delete(key);
  knownText.delete(key);
  forcedEncodings.delete(key);
}

/*
 * ── Opening ───────────────────────────────────────────────────────────────────────────────────
 * Every open funnels through openAndWatchFile: the dialog, argv and second instances, and
 * open-recent-file (recents, drag and drop, session restore).
 *
 * Reads run in parallel, but tabs are delivered in the order the opens were asked for. Session
 * restore asks for every path at once, and with async reads a small file would otherwise
 * overtake a large one and shuffle the user's tabs. The wait for an earlier open is capped at
 * OPEN_ORDER_WAIT_MS, so one tab on a dead network share cannot hold every other tab back for
 * the whole network timeout; it arrives late, in its own time.
 */
const OPEN_ORDER_WAIT_MS = 2000;
let openDelivery = Promise.resolve();

/**
 * Open a file in a tab and watch it. Resolves { ok: true }, or { ok: false, reason }: 'missing'
 * (gone, or not a file; quiet, as always, since a stale recent or a restored tab whose file was
 * deleted is not news) or 'error' (the user has been told why).
 */
function openAndWatchFile(filePath, opts = {}) {
  const reading = readDocument(filePath).then((doc) => ({ doc }), (err) => ({ err }));
  const turn = Promise.race([openDelivery, new Promise((resolve) => setTimeout(resolve, OPEN_ORDER_WAIT_MS))]);
  const delivered = turn
    .then(() => reading)
    .then(({ doc, err }) => deliverOpenedFile(filePath, opts, doc, err))
    .catch((err) => {
      console.error('Error opening file:', err);
      return { ok: false, reason: 'error' };
    });
  openDelivery = delivered;
  return delivered;
}

function deliverOpenedFile(filePath, opts, doc, err) {
  if (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'NOT_FILE') return { ok: false, reason: 'missing' };
    reportOpenFailure(filePath, err, opts);
    return { ok: false, reason: 'error' };
  }
  /*
   * Since tabs, opening a file ADDS a tab rather than replacing anything, so there is no
   * unsaved-changes gate here any more. (If the file is already open, the renderer just
   * activates its existing tab.) Dirty buffers are guarded where something is actually
   * discarded: closing a tab, and closing the window.
   */
  const key = watchKey(filePath);
  const format = adoptFormat(key, doc);
  fileFormats.set(key, format);
  knownText.set(key, textDigest(doc.text));
  rememberRecentFile(filePath);

  if (mainWindow) {
    /*
     * `fromRestore` rides along so the renderer can tell a tab the user just asked for from one
     * it is merely reinstating. Session restore replays every path from last time, and each
     * replay used to activate its tab, so double-clicking a file to LAUNCH FATE landed you on
     * whichever restored tab happened to arrive last, not on the file you opened.
     * `format` is how the file is stored; the text itself is already decoded, BOM-free, `\n`.
     */
    mainWindow.webContents.send('open-file', doc.text, path.basename(filePath), filePath, {
      fromRestore: !!opts.fromRestore,
      format
    });
  }
  fileWatcher.watch(filePath);
  return { ok: true };
}

/** Error-box wording for a file that would not open, plus the reason/advice a summary lists. */
function describeOpenFailure(filePath, err) {
  const name = path.basename(filePath);
  const limitMb = MAX_FILE_BYTES / 1048576;
  if (err.code === 'TOO_LARGE') {
    const mb = (err.size / 1048576).toFixed(1);
    return {
      title: 'File too large',
      message: `${name} is ${mb} MB. FATE opens text files up to ${limitMb} MB.`,
      reason: `${mb} MB, over the ${limitMb} MB limit`,
      advice: null
    };
  }
  if (err.code === 'BINARY') {
    return {
      title: 'Not a text file',
      message: `${name} appears to be a binary file, which FATE cannot display.`,
      reason: 'looks like a binary file',
      advice: null
    };
  }
  // Under snap confinement "permission denied" means an interface is not connected, and until
  // 1.13.2 it looked exactly like "no such file"; describeFsError says which.
  const { title, message, reason, advice } = describeFsError(err, filePath, 'open');
  return { title, message, reason, advice };
}

/*
 * Session restore reopens every tab at once, and each one that failed used to raise its own modal
 * error box: a session on an unplugged drive meant clicking through a box per file. Failures of
 * restored tabs are collected instead and reported in ONE dialog once they stop arriving: each
 * file with its reason, then each distinct remedy (such as the snap guidance) once.
 */
const RESTORE_REPORT_DELAY_MS = 600;
const restoreFailures = [];
let restoreReportTimer = null;

function reportOpenFailure(filePath, err, opts) {
  const failure = describeOpenFailure(filePath, err);
  if (!opts.fromRestore) {
    dialog.showErrorBox(failure.title, failure.message);
    return;
  }
  restoreFailures.push({ name: path.basename(filePath), ...failure });
  clearTimeout(restoreReportTimer);
  restoreReportTimer = setTimeout(showRestoreFailures, RESTORE_REPORT_DELAY_MS);
}

function showRestoreFailures() {
  restoreReportTimer = null;
  const failures = restoreFailures.splice(0);
  if (failures.length === 0) return;
  let options;
  if (failures.length === 1) {
    const [failure] = failures;
    options = { type: 'error', title: failure.title, message: failure.title, detail: failure.message };
  } else {
    const remedies = [...new Set(failures.map((f) => f.advice).filter(Boolean))];
    options = {
      type: 'warning',
      title: 'Some tabs could not be restored',
      message: `FATE couldn't reopen ${failures.length} files from your last session.`,
      detail: [failures.map((f) => `${f.name}: ${f.reason}`).join('\n'), ...remedies].join('\n\n')
    };
  }
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).catch(() => {});
}

/**
 * Open a path the renderer names (a recents entry, a dropped file, a restored session tab); also
 * the way in for an Open Recent menu. A missing file is dropped from recents so the list heals
 * itself instead of offering it again. Resolves { ok } or { ok: false, reason }.
 */
async function openRecentFile(filePath, opts) {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'missing' };
  const result = await openAndWatchFile(filePath, { fromRestore: !!(opts && opts.fromRestore) });
  if (result.reason === 'missing') forgetRecentFile(filePath);
  return result;
}

/*
 * ── Saving ────────────────────────────────────────────────────────────────────────────────────
 * The renderer hands over `\n` text and, optionally, the format to write it in. Without one, the
 * format the path was opened or last saved with applies (fileFormats), and for a path FATE has
 * never read, the platform default, so a CRLF or UTF-16 file goes back the way it came.
 */
const saveFailure = (code, error) => ({ ok: false, code, error });

/** Settle the format and encode, before anything touches the disk: { ok, format, data } or a failure. */
function prepareSave(name, content, passedFormat, recordedFormat) {
  try {
    const format = resolveFormat(passedFormat, recordedFormat || defaultFormat());
    return { ok: true, format, data: encode(content, format) };
  } catch (err) {
    // UNENCODABLE's message says what and where: "“→” (U+2192) on line 3 can't be saved in
    // Windows-1252. Save the file as UTF-8 instead."
    if (err.code === 'UNENCODABLE') return saveFailure(err.code, `${name}: ${err.message}`);
    return saveFailure(err.code || 'BAD_FORMAT', `Can't save ${name}: ${err.message}`);
  }
}

/**
 * Write encoded bytes atomically (textFiles.cjs) and record what is now on disk. The path's
 * watcher is held meanwhile, so neither a reload racing the write nor the write's own events can
 * come back to the renderer as an external change; then it is re-armed, because an atomic save
 * leaves a new file at the path.
 */
async function commitSave(filePath, prepared, content) {
  const key = watchKey(filePath);
  const release = fileWatcher.hold(filePath);
  try {
    await writeFileAtomic(filePath, prepared.data);
    fileFormats.set(key, prepared.format);
    knownText.set(key, textDigest(normalizeText(content)));
    if (forcedEncodings.get(key) !== prepared.format.encoding) forcedEncodings.delete(key);
    fileWatcher.watch(filePath, { rearm: true });
    return { ok: true, format: prepared.format };
  } catch (err) {
    return saveFailure(err.code || 'EIO', describeFsError(err, filePath, 'save').short);
  } finally {
    release();
  }
}

/*
 * ── Opening files from a command line ─────────────────────────────────────────────────────────
 * Selecting several files in a file manager and choosing Open with FATE passes them all, so every
 * openable argument opens, in order (up to 1.13.4 only the first did). Relative paths resolve
 * against the working directory of the process that received them; see launchArgs.cjs.
 *
 * `rendererReady`: 'open-file' sent before the renderer has registered its listener is lost, so a
 * second instance's command line that arrives while the window is still loading waits in
 * `pendingSecondInstanceArgs` until 'app-ready' (createWindow).
 */
let rendererReady = false;
const pendingSecondInstanceArgs = [];
let openArgsQueue = Promise.resolve();

function handleArgs(argv, cwd) {
  // argv also carries the exe path, the app path in dev, and Chromium switches; see
  // isOpenableArg for why this is a shape check and not an extension list.
  const seen = new Set();
  const files = candidateFilePaths(argv, { cwd }).filter((filePath) => {
    const key = watchKey(filePath);
    if (seen.has(key) || !isOpenableArg(filePath)) return false;
    seen.add(key);
    return true;
  });
  // One at a time, and one command line after another: the tabs open in the order given, and the
  // last file named is the one left in front.
  openArgsQueue = openArgsQueue.then(async () => {
    for (const filePath of files) {
      try {
        await openAndWatchFile(filePath);
      } catch (err) {
        console.error('Could not open', filePath, err);
      }
    }
  });
  return openArgsQueue;
}

app.whenReady().then(() => {
  if (!gotTheLock) return; // a second instance: it handed its files over and is quitting (top of file)

  // Register custom protocol for local images
  /*
   * Local images referenced from a markdown file. URL shape: fate-local://local/<encoded absolute
   * path>: `/C%3A/Users/…` on Windows, `/home/…` elsewhere (built in src/markdown.js).
   *
   * The fixed `local` host is what makes this work at all. fate-local is registered as a
   * STANDARD scheme, and Chromium canonicalises `scheme:///C:/x` for standard schemes the way it
   * does `http:///example.com`: the empty authority collapses, so `C:` became the host (lower-cased
   * to `c`, the colon read as a port separator) and the handler received `c/Users/…`, a relative
   * path that never existed. Every local image failed with net::ERR_FILE_NOT_FOUND while the
   * <img src> attribute still read `fate-local:///C:/…`. Verified on Electron 42.3.3 and 42.11.3
   * alike; it was never a Chromium regression, just the URL shape.
   *
   * What it will serve (absolute local paths to image files, never a network path) is decided in
   * resolveLocalImagePath, which explains each refusal. Network paths are refused BEFORE anything
   * touches the file system: even a stat of `\\host\share\x.png` makes Windows connect to the host.
   */
  protocol.handle('fate-local', async (request) => {
    const target = resolveLocalImagePath(request.url, process.platform);
    if (!target.ok) return new Response(target.reason, { status: target.status });
    try {
      const stat = await fs.promises.stat(target.filePath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
    } catch {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target.filePath).toString());
  });

  startAppShell(); // spellcheck, the application menu and their IPC; before the window exists
  createWindow();
  
  ipcMain.handle('get-app-version', () => app.getVersion());
  
  /**
   * The renderer sends the open document's filename (or null on the home screen), never a full
   * title string. Composition is owned by composeTitle() so the app name always leads and the
   * taskbar label can never regress to a bare "FATE".
   */
  ipcMain.on('set-title', (event, docName, edited) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setTitle(composeTitle(docName, edited));
  });

  /*
   * The renderer mirrors its dirty flag here on every transition, so the main process can guard
   * window close and file opens without a round trip at decision time. (Asking the renderer
   * "are you dirty?" during the 'close' event would need sync IPC; this inversion avoids that.)
   */
  ipcMain.on('set-edited', (event, edited) => {
    documentEdited = !!edited;
  });

  /*
   * Settings: only the keys the renderer owns, each type-checked (rendererSettings.cjs). Main-only
   * state such as recentFiles and the Windows registrationStamp is out of the renderer's reach.
   */
  ipcMain.handle('store-get', (event, key) => (isRendererSettingKey(key) ? store.get(key) : undefined));
  ipcMain.handle('store-set', (event, key, val) => {
    const check = checkRendererSetting(key, val);
    if (!check.ok) {
      console.warn(`store-set refused: ${check.error}`);
      return check;
    }
    store.set(key, val);
    return { ok: true };
  });

  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      // "All files" FIRST, so it is the default: FATE opens any text file, and hiding
      // `web.config`, `.properties` or an extensionless Dockerfile behind a filter switch made
      // it look as though it could not. The curated filters stay for narrowing a busy folder.
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'Markdown', extensions: [...MARKDOWN_EXTENSIONS] },
        { name: 'Code files', extensions: [...CODE_EXTENSIONS] }
      ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      openAndWatchFile(filePath);
    }
  });

  // ── Saving ────────────────────────────────────────────────────────────────────────────────
  /**
   * Save a tab to its own path, in the format passed or else the path's recorded one. Only paths
   * FATE has open are accepted (isOpenPath); anywhere else is refused, and Save As is the way to
   * write somewhere new. Resolves { ok: true, format } with the format actually written, or
   * { ok: false, code, error }.
   */
  ipcMain.handle('save-file', async (event, filePath, content, format) => {
    if (typeof filePath !== 'string' || !filePath) return saveFailure('BAD_ARGS', 'No file path to save to');
    if (typeof content !== 'string') return saveFailure('BAD_ARGS', 'Nothing to save');
    const name = path.basename(filePath);
    if (!isOpenPath(filePath)) {
      return saveFailure('NOT_OPEN', `Can't save ${name}: it isn't a file FATE has open. Use Save As instead.`);
    }
    const prepared = prepareSave(name, content, format, fileFormats.get(watchKey(filePath)));
    return prepared.ok ? commitSave(filePath, prepared, content) : prepared;
  });

  /**
   * Save As. Writes wherever the user picks, then RETARGETS that tab's watcher and the recents to
   * the new path without re-sending 'open-file'. The renderer already holds the content, and a
   * reload would discard the cursor and scroll position. The renderer updates its own name/path
   * from the response instead. `oldPath` (the tab's previous path, if any) stops being watched.
   *
   * The format is the one passed, else `oldPath`'s, else the default, and the text is encoded
   * BEFORE the dialog opens, so text that Windows-1252 can't hold fails without a wasted dialog.
   */
  ipcMain.handle('save-file-as', async (event, suggestedName, content, oldPath, format) => {
    if (typeof content !== 'string') return saveFailure('BAD_ARGS', 'Nothing to save');
    const suggested = typeof suggestedName === 'string' && suggestedName ? suggestedName : 'untitled.txt';
    const fromPath = isOpenPath(oldPath) ? oldPath : null;
    const prepared = prepareSave(suggested, content, format, fromPath && fileFormats.get(watchKey(fromPath)));
    if (!prepared.ok) return prepared;

    let filePath;
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save As',
        defaultPath: suggested,
        // "All files" first: with a curated filter selected, Windows appends that filter's first
        // extension to any name typed without one, so saving a new buffer as `Dockerfile` or
        // `.env` produced `Dockerfile.md`. The typed name is now taken literally.
        filters: [
          { name: 'All files', extensions: ['*'] },
          { name: 'Markdown', extensions: [...MARKDOWN_EXTENSIONS] },
          { name: 'Code files', extensions: [...CODE_EXTENSIONS] }
        ]
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      filePath = result.filePath;
    } catch (err) {
      return saveFailure('DIALOG', err.message);
    }

    const saved = await commitSave(filePath, prepared, content);
    if (!saved.ok) return saved;
    if (fromPath && watchKey(fromPath) !== watchKey(filePath)) forgetPath(fromPath);
    rememberRecentFile(filePath);
    return { ok: true, filePath, name: path.basename(filePath), format: saved.format };
  });

  /** A tab closed: stop watching its file, and stop accepting saves to it (forgetPath). */
  ipcMain.on('close-file', (event, filePath) => {
    forgetPath(filePath);
  });

  /**
   * Re-read an open file decoding it as `encoding`, for a file whose encoding was guessed wrong.
   * Refused rather than opened lossy when that decoding could not be saved back unchanged (see
   * fileFormat.decode). The choice sticks for the tab's later reloads (forcedEncodings). The
   * watcher is held so a reload already in flight, decoded the old way, cannot land afterwards.
   * Resolves { ok: true, content, format } or { ok: false, code, error }.
   */
  ipcMain.handle('reopen-with-encoding', async (event, filePath, encoding) => {
    if (!isOpenPath(filePath)) return { ok: false, code: 'NOT_OPEN', error: "That file isn't open in FATE" };
    if (!ENCODINGS.includes(encoding)) return { ok: false, code: 'BAD_ENCODING', error: `Unknown encoding: ${String(encoding)}` };
    const key = watchKey(filePath);
    const name = path.basename(filePath);
    const release = fileWatcher.hold(filePath);
    try {
      const doc = await readTextFile(filePath, {
        maxBytes: MAX_FILE_BYTES,
        forcedEncoding: encoding,
        defaultEol: fileFormats.get(key)?.eol
      });
      if (!isOpenPath(filePath)) return { ok: false, code: 'NOT_OPEN', error: `${name} was closed` };
      fileFormats.set(key, doc.format);
      knownText.set(key, textDigest(doc.text));
      forcedEncodings.set(key, encoding);
      return { ok: true, content: doc.text, format: doc.format };
    } catch (err) {
      if (err.code === 'BINARY' || err.code === 'INVALID') {
        return { ok: false, code: err.code, error: `Can't reopen ${name} as ${ENCODING_LABELS[encoding]}: ${err.message}.` };
      }
      if (err.code === 'TOO_LARGE') return { ok: false, code: err.code, error: describeOpenFailure(filePath, err).message };
      return { ok: false, code: err.code, error: describeFsError(err, filePath, 'open').short };
    } finally {
      release();
    }
  });

  /**
   * Native "discard unsaved changes?" confirmation for renderer-initiated closes (Escape, the
   * Back button). Returns true when the user chooses to discard.
   */
  ipcMain.handle('confirm-discard', async (event, message) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: message || 'Discard unsaved changes?',
      detail: 'Your edits have not been saved.'
    });
    return response === 0;
  });

  /**
   * The per-tab prompt of the close walk: Save / Don't save / Cancel.
   *
   * Cancel is both the default and the Escape action deliberately. This dialog appears while the
   * app is on its way out, so the safe answer to a stray keypress is "stop", never "throw the
   * edits away".
   */
  ipcMain.handle('confirm-save-on-close', async (event, docName) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: `Save changes to ${docName || 'this document'} before closing?`,
      detail: "If you don't save, your changes will be lost."
    });
    return ['save', 'discard', 'cancel'][response] || 'cancel';
  });
  
  // ── Recent documents ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('get-recent-files', () => readRecentFiles());

  // Recents, drag and drop and session restore all open through here (see openRecentFile).
  ipcMain.handle('open-recent-file', (event, filePath, opts) => openRecentFile(filePath, opts));

  ipcMain.handle('clear-recent-files', () => {
    clearRecentFiles();
    return { ok: true };
  });

  // ── Hot exit ──────────────────────────────────────────────────────────────────────────────
  /*
   * Unsaved buffers, backed up by the renderer a moment after each change and offered back after
   * a crash (backups.cjs owns the file format, the id rules and the size caps). Failures resolve
   * { ok: false, code, error } rather than reject; a backup folder that can't be read lists as [].
   */
  const backups = createBackupStore(path.join(app.getPath('userData'), 'backups'));
  const backupResult = (job) =>
    job.then(
      (value) => ({ ok: true, ...value }),
      (err) => ({ ok: false, code: err.code, error: err.message })
    );
  ipcMain.handle('backup-write', (event, id, data) => backupResult(backups.write(id, data)));
  ipcMain.handle('backup-remove', (event, id) => backupResult(backups.remove(id)));
  ipcMain.handle('backup-clear', () => backupResult(backups.clear()));
  ipcMain.handle('backup-list', () =>
    backups.list().catch((err) => {
      console.error('Could not list backups:', err.message);
      return [];
    })
  );

  // ── Printing & PDF export ─────────────────────────────────────────────────────────────────
  // Both are wrapped so a render failure surfaces in the UI instead of rejecting into the void.
  ipcMain.handle('print-preview', async (event, docName) => {
    try {
      return await showPrintPreview(docName);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export-pdf', async (event, docName) => {
    try {
      return await exportPdf(docName);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Default-app association ───────────────────────────────────────────────────────────────
  ipcMain.handle('get-default-app-status', () => getDefaultAppStatus());
  ipcMain.handle('request-default-app', () => requestDefaultAppAssociation());
  ipcMain.handle('get-association-coverage', () => getAssociationCoverage());
  ipcMain.handle('repair-associations', () => repairAssociations());

  /** Build facts the renderer adjusts its UI to (Store builds get Store-owned updates). */
  ipcMain.handle('get-runtime-info', () => ({
    windowsStore: isWindowsStore,
    platform: process.platform,
    /** { managed, kind, label }: who updates this install; see detectUpdateSource. */
    updates: updateSource
  }));

  /*
   * Font families installed on this machine, for Settings → Fonts. Enumerated once per app run
   * via GDI+ (one hidden PowerShell call, ~300 names) and cached; font installs mid-session are
   * rare enough that a restart picking them up is fine. Purely local: the list never leaves the
   * process, matching the privacy posture.
   *
   * The cache holds the PROMISE, so callers that arrive while the enumeration is still running
   * share it instead of each starting another PowerShell or fc-list (the old cache only filled in
   * once the first run finished). An empty result is not kept, so a run that failed (no fc-list,
   * a timeout) is retried by the next caller.
   */
  let systemFontsPromise = null;
  const finishFontList = (resolve, names) => {
    const clean = names.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
    resolve([...new Set(clean)].sort((a, b) => a.localeCompare(b)));
  };
  const enumerateSystemFonts = () => {
    if (process.platform !== 'win32') {
      /*
       * Linux/macOS: fontconfig's `fc-list : family` prints one line per face, and a line can
       * carry several comma-separated names (localised aliases); take the first. Absent fc-list
       * (unusual outside a container) the picker just offers the bundled set.
       */
      return new Promise((resolve) => {
        execFile('fc-list', [':', 'family'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          finishFontList(resolve, stdout.split('\n').map((line) => line.split(',')[0]));
        });
      });
    }
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          // See runPowerShell: -WindowStyle Hidden alongside windowsHide, because this one runs
          // on the launch path and a flash here reads as "FATE ran my script before opening it".
          '-WindowStyle',
          'Hidden',
          '-Command',
          'Add-Type -AssemblyName System.Drawing; ([System.Drawing.Text.InstalledFontCollection]::new()).Families | ForEach-Object { $_.Name } | ConvertTo-Json -Compress'
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          try {
            finishFontList(resolve, [].concat(JSON.parse(stdout.trim())));
          } catch {
            resolve([]);
          }
        }
      );
    });
  };
  ipcMain.handle('get-system-fonts', () => {
    if (!systemFontsPromise) {
      systemFontsPromise = enumerateSystemFonts().then((fonts) => {
        if (fonts.length === 0) systemFontsPromise = null;
        return fonts;
      });
    }
    return systemFontsPromise;
  });

  /*
   * ── Classic context menus (opt-in, Settings → Windows) ─────────────────────────────────────
   * Windows 11's modern right-click menu only surfaces packaged IExplorerCommand handlers at the
   * top level; classic verbs like "Edit in FATE" sit under "Show more options". This well-known
   * per-user tweak (an empty InprocServer32 under this CLSID) makes Explorer always show the full
   * classic menu, where FATE's verb IS top-level. Fully reversible; takes effect when Explorer
   * restarts. FATE only ever creates/deletes this exact key, and only when the user asks.
   */
  const CLASSIC_MENU_CLSID = 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}';

  ipcMain.handle('get-classic-menu', () =>
    new Promise((resolve) => {
      execFile('reg', ['query', `${CLASSIC_MENU_CLSID}\\InprocServer32`, '/ve'], { windowsHide: true }, (err) =>
        resolve(!err)
      );
    })
  );

  ipcMain.handle('set-classic-menu', (event, enabled) =>
    new Promise((resolve) => {
      const args = enabled
        ? ['add', `${CLASSIC_MENU_CLSID}\\InprocServer32`, '/ve', '/d', '', '/f']
        : ['delete', CLASSIC_MENU_CLSID, '/f'];
      execFile('reg', args, { windowsHide: true }, (err) =>
        resolve({ ok: !err, error: err?.message })
      );
    })
  );

  /** Explorer restart, so the classic-menu change applies without a sign-out. */
  ipcMain.handle('restart-explorer', () =>
    new Promise((resolve) => {
      execFile('cmd', ['/c', 'taskkill /f /im explorer.exe & start explorer.exe'], { windowsHide: true }, (err) =>
        resolve({ ok: !err })
      );
    })
  );

  // The status-bar button and the palette; Help → Check for Updates runs the same function.
  ipcMain.handle('check-for-updates', () => {
    checkForUpdatesNow();
  });

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on('checking-for-update', () => {
    if(mainWindow) mainWindow.webContents.send('update-message', 'Checking for updates...', null);
  });
  
  autoUpdater.on('update-available', (info) => {
    if(mainWindow) mainWindow.webContents.send('update-message', `Update v${info.version} available! Downloading...`, null);
  });
  
  autoUpdater.on('update-not-available', () => {
    if(mainWindow) mainWindow.webContents.send('update-message', 'You are on the latest version.', null);
  });
  
  autoUpdater.on('error', (err) => {
    if(mainWindow) mainWindow.webContents.send('update-message', `Error checking for updates: ${err.message}`, null);
  });
  
  autoUpdater.on('update-downloaded', () => {
    if(mainWindow) mainWindow.webContents.send('update-message', 'Update downloaded! Ready to install.', 'install');
  });

  if (!isDev && !updateSource.managed) {
    // Offline launches reject here; the 'error' handler above has already told the status bar.
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  ensureWindowsRegistration();

  /*
   * Repair before the user can trip over it, on every launch rather than behind a stamp: the
   * `.bat` hijack it undoes can be re-created at any time from Windows Settings (up to 1.11.5
   * FATE listed .bat on its own Default-apps page), so a once-per-version check would leave a
   * window where batch files silently stop running. Async, off the startup path, and a no-op
   * when there is nothing to fix.
   */
  if (process.platform === 'win32' && app.isPackaged) {
    repairAssociations()
      .then((r) => {
        if (r.restored?.length) console.log('Restored the command processor for:', r.restored.join(', '));
        if (r.fixed?.length) console.log('Cleared dead class defaults for', r.fixed.length, 'types');
      })
      .catch(() => {});
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/*
 * Another launch while FATE runs (a file double-clicked, Open with FATE): the lock at the top of
 * this file turned it away, and its command line arrives here. Its relative paths are relative to
 * ITS working directory, not this process's. A launch that lands while the window is still
 * loading is queued for 'app-ready' rather than sent to a renderer that is not listening yet.
 */
if (gotTheLock) {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (rendererReady) handleArgs(commandLine, workingDirectory);
    else pendingSecondInstanceArgs.push({ argv: commandLine, cwd: workingDirectory });
  });
}
