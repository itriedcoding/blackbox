/**
 * Extension → editor mode table.
 *
 * `mode` is the CodeMirror 5 MIME string; `modeFile` is the vendored mode
 * script the renderer loads on demand. A file with no entry still opens and
 * still edits — it is only the syntax highlighting that is unavailable, which
 * matters because the model can write any language it was trained on.
 */

const LANGS = {
  js: { label: "JavaScript", mode: "javascript", modeFile: "javascript" },
  mjs: { label: "JavaScript", mode: "javascript", modeFile: "javascript" },
  cjs: { label: "JavaScript", mode: "javascript", modeFile: "javascript" },
  jsx: { label: "JSX", mode: "jsx", modeFile: "javascript" },
  ts: { label: "TypeScript", mode: "text/typescript", modeFile: "javascript" },
  tsx: { label: "TSX", mode: "text/typescript-jsx", modeFile: "javascript" },
  json: { label: "JSON", mode: "application/json", modeFile: "javascript" },
  jsonc: { label: "JSON", mode: "application/json", modeFile: "javascript" },
  html: { label: "HTML", mode: "htmlmixed", modeFile: "htmlmixed" },
  htm: { label: "HTML", mode: "htmlmixed", modeFile: "htmlmixed" },
  vue: { label: "Vue", mode: "htmlmixed", modeFile: "htmlmixed" },
  svelte: { label: "Svelte", mode: "htmlmixed", modeFile: "htmlmixed" },
  xml: { label: "XML", mode: "xml", modeFile: "xml" },
  svg: { label: "SVG", mode: "xml", modeFile: "xml" },
  css: { label: "CSS", mode: "css", modeFile: "css" },
  scss: { label: "SCSS", mode: "text/x-scss", modeFile: "css" },
  sass: { label: "Sass", mode: "text/x-sass", modeFile: "css" },
  less: { label: "Less", mode: "text/x-less", modeFile: "css" },
  py: { label: "Python", mode: "python", modeFile: "python" },
  pyi: { label: "Python", mode: "python", modeFile: "python" },
  md: { label: "Markdown", mode: "markdown", modeFile: "markdown" },
  markdown: { label: "Markdown", mode: "markdown", modeFile: "markdown" },
  c: { label: "C", mode: "text/x-csrc", modeFile: "clike" },
  h: { label: "C header", mode: "text/x-csrc", modeFile: "clike" },
  cc: { label: "C++", mode: "text/x-c++src", modeFile: "clike" },
  cpp: { label: "C++", mode: "text/x-c++src", modeFile: "clike" },
  cxx: { label: "C++", mode: "text/x-c++src", modeFile: "clike" },
  hpp: { label: "C++ header", mode: "text/x-c++src", modeFile: "clike" },
  cs: { label: "C#", mode: "text/x-csharp", modeFile: "clike" },
  java: { label: "Java", mode: "text/x-java", modeFile: "clike" },
  kt: { label: "Kotlin", mode: "text/x-kotlin", modeFile: "clike" },
  kts: { label: "Kotlin", mode: "text/x-kotlin", modeFile: "clike" },
  scala: { label: "Scala", mode: "text/x-scala", modeFile: "clike" },
  m: { label: "Objective-C", mode: "text/x-objectivec", modeFile: "clike" },
  mm: { label: "Objective-C++", mode: "text/x-objectivec", modeFile: "clike" },
  rs: { label: "Rust", mode: "text/x-rustsrc", modeFile: "rust" },
  go: { label: "Go", mode: "text/x-go", modeFile: "go" },
  sql: { label: "SQL", mode: "text/x-sql", modeFile: "sql" },
  yaml: { label: "YAML", mode: "text/x-yaml", modeFile: "yaml" },
  yml: { label: "YAML", mode: "text/x-yaml", modeFile: "yaml" },
  sh: { label: "Shell", mode: "text/x-sh", modeFile: "shell" },
  bash: { label: "Bash", mode: "text/x-sh", modeFile: "shell" },
  zsh: { label: "Zsh", mode: "text/x-sh", modeFile: "shell" },
  fish: { label: "Shell", mode: "text/x-sh", modeFile: "shell" },
  ps1: { label: "PowerShell", mode: "text/x-powershell", modeFile: "powershell" },
  bat: { label: "Batch", mode: "text/x-sh", modeFile: "shell" },
  cmd: { label: "Batch", mode: "text/x-sh", modeFile: "shell" },
  php: { label: "PHP", mode: "application/x-httpd-php", modeFile: "php" },
  rb: { label: "Ruby", mode: "text/x-ruby", modeFile: "ruby" },
  swift: { label: "Swift", mode: "text/x-swift", modeFile: "swift" },
  dart: { label: "Dart", mode: "application/dart", modeFile: "dart" },
  lua: { label: "Lua", mode: "text/x-lua", modeFile: "lua" },
  r: { label: "R", mode: "text/x-rsrc", modeFile: "r" },
  hs: { label: "Haskell", mode: "text/x-haskell", modeFile: "haskell" },
  cmake: { label: "CMake", mode: "text/x-cmake", modeFile: "cmake" },
  toml: { label: "TOML", mode: "text/x-toml", modeFile: "toml" },
  ini: { label: "INI", mode: "text/x-properties", modeFile: null },
  pl: { label: "Perl", mode: "text/x-perl", modeFile: "perl" },
  jl: { label: "Julia", mode: "text/x-julia", modeFile: "julia" },
  erl: { label: "Erlang", mode: "text/x-erlang", modeFile: "erlang" },
  clj: { label: "Clojure", mode: "text/x-clojure", modeFile: "clojure" },
  coffee: { label: "CoffeeScript", mode: "text/x-coffeescript", modeFile: "coffeescript" },
  vb: { label: "Visual Basic", mode: "text/x-vb", modeFile: "vb" },
  diff: { label: "Diff", mode: "text/x-diff", modeFile: "diff" },
  patch: { label: "Diff", mode: "text/x-diff", modeFile: "diff" },
  conf: { label: "Config", mode: "text/x-nginx-conf", modeFile: "nginx" },
  groovy: { label: "Groovy", mode: "text/x-groovy", modeFile: "groovy" },
  txt: { label: "Text", mode: null, modeFile: null },
};

const BY_FILENAME = {
  dockerfile: { label: "Dockerfile", mode: "text/x-dockerfile", modeFile: "dockerfile" },
  makefile: { label: "Makefile", mode: "text/x-cmake", modeFile: "cmake" },
  "cmakelists.txt": { label: "CMake", mode: "text/x-cmake", modeFile: "cmake" },
  ".gitignore": { label: "Ignore list", mode: "text/x-sh", modeFile: "shell" },
  ".env": { label: "Environment", mode: "text/x-sh", modeFile: "shell" },
  ".editorconfig": { label: "Editor config", mode: "text/x-properties", modeFile: null },
  "package.json": { label: "npm manifest", mode: "application/json", modeFile: "javascript" },
  "tsconfig.json": { label: "TypeScript config", mode: "application/json", modeFile: "javascript" },
  "cargo.toml": { label: "Cargo manifest", mode: "text/x-toml", modeFile: "toml" },
  "requirements.txt": { label: "Requirements", mode: "text/x-sh", modeFile: "shell" },
};

export const PLAIN_TEXT = { label: "Plain text", mode: null, modeFile: null };

/** Language descriptor for a relative path; never throws. */
export function languageFor(relativePath) {
  const name = String(relativePath ?? "").split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (BY_FILENAME[lower]) return { ...BY_FILENAME[lower], id: lower };
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return { ...PLAIN_TEXT, id: "text" };
  const ext = lower.slice(dot + 1);
  const found = LANGS[ext];
  if (found) return { ...found, id: ext };
  return { ...PLAIN_TEXT, id: ext };
}

/** Every extension the table knows, for the UI's stat line. */
export function languageCount() {
  return new Set(Object.values(LANGS).map((entry) => entry.label)).size;
}
