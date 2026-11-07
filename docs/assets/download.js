// "Download as .cmd" — turns a CMD or PowerShell code block into a file you can double-click.
//
// * CMD blocks run as a normal batch file.
// * PowerShell blocks are wrapped in a CMD/PowerShell hybrid, so they also run on double-click
//   (a .ps1 would just open in Notepad).
// * "Run as admin" items ask for elevation (UAC) by themselves.
// * The file pauses so you can read the output, then deletes itself — nothing is left on the client PC.

export const DOWNLOADABLE_LANGS = new Set(['cmd', 'powershell']);

const ascii = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();

export function fileNameFor(title) {
  const slug = ascii(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'itsupport-script'}.cmd`;
}

/** Characters that would break `title` / `echo` lines in a batch file. */
const batchSafe = (s) => ascii(s).replace(/[&|<>^%"()!]/g, ' ').replace(/\s+/g, ' ').trim();

function header({ title, admin }) {
  const name = batchSafe(title) || 'IT Support script';
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `title IT Support - ${name}`,
  ];
  if (admin) {
    // fltmc only works when elevated. "--elevated" stops an endless loop if elevation is refused.
    lines.push(
      'fltmc >nul 2>&1',
      'if errorlevel 1 if not "%~1"=="--elevated" (',
      '  echo Asking for administrator rights...',
      `  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs"`,
      '  exit /b',
      ')',
    );
  }
  lines.push(`echo === ${name} ===`, 'echo.');
  return lines;
}

const FOOTER = [
  'echo.',
  'echo Finished. This file deletes itself when you press a key.',
  'pause >nul',
  '(goto) 2>nul & del "%~f0"',
];

/**
 * @param {{title: string, lang: string, code: string, admin?: boolean}} block  code with variables already filled in
 * @returns {{fileName: string, text: string}}
 */
export function buildCmdFile({ title, lang, code, admin = false }) {
  const body = String(code).replace(/\r\n?/g, '\n').split('\n');
  let lines;
  if (lang === 'powershell') {
    // Hybrid file: CMD runs the part inside <# ... #>; PowerShell sees that part as a comment
    // and runs everything after it.
    lines = [
      '<# :',
      ...header({ title, admin }),
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText('%~f0')))"`,
      ...FOOTER,
      '#>',
      ...body,
    ];
  } else {
    lines = [
      ...header({ title, admin }),
      'prompt $G$S',
      '@echo on',
      ...body,
      '@echo off',
      ...FOOTER,
    ];
  }
  // CRLF line endings: batch files misbehave with LF-only lines. No BOM (it would break "@echo off").
  return { fileName: fileNameFor(title), text: lines.join('\r\n') + '\r\n' };
}

/** Save text as a file through the browser's normal download. */
export function saveFile(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
