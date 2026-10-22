/** Code and configuration categories with embedded full-color glyphs. */
export const CODE_FILE_TYPES = [
  'angular',
  'c',
  'clojure',
  'cmake',
  'cpp',
  'csharp',
  'css',
  'dart',
  'docker',
  'elixir',
  'env',
  'erlang',
  'flutter',
  'git',
  'go',
  'graphql',
  'haskell',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'makefile',
  'node',
  'objective-c',
  'perl',
  'php',
  'powershell',
  'protobuf',
  'python',
  'r',
  'react',
  'ruby',
  'rust',
  'scala',
  'shell',
  'solidity',
  'sql',
  'svelte',
  'swift',
  'toml',
  'typescript',
  'vue',
  'wasm',
  'xml',
  'yaml',
  'zig',
] as const

/** A code or configuration file category with its own full-color square glyph. */
export type CodeFileType = typeof CODE_FILE_TYPES[number]

/** Optional project files used by context-sensitive code-icon rules. */
export interface FileTypeProjectContext {
  /** Text content keyed by project-relative or basename path. */
  readonly files: Readonly<Record<string, string | undefined>>
}

const CODE_FILE_TYPE_SET = new Set<string>(CODE_FILE_TYPES)

const FILE_NAME_TYPES: Readonly<Record<string, CodeFileType>> = {
  '.bash_profile': 'shell',
  '.bashrc': 'shell',
  '.env': 'env',
  '.gitattributes': 'git',
  '.gitconfig': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.mailmap': 'git',
  '.profile': 'shell',
  '.zprofile': 'shell',
  '.zshrc': 'shell',
  'bsdmakefile': 'makefile',
  'cmakelists.txt': 'cmake',
  'commit_editmsg': 'git',
  'compose.yaml': 'docker',
  'compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'docker-compose.yml': 'docker',
  'dockerfile': 'docker',
  'gemfile': 'ruby',
  'gnumakefile': 'makefile',
  'guardfile': 'ruby',
  'makefile': 'makefile',
  'npm-shrinkwrap.json': 'node',
  'package-lock.json': 'node',
  'package.json': 'node',
  'podfile': 'ruby',
  'rakefile': 'ruby',
}

const FILE_NAME_PREFIX_TYPES: readonly (readonly [string, CodeFileType])[] = [
  ['dockerfile.', 'docker'],
  ['.env.', 'env'],
]

const FILE_NAME_SUFFIX_TYPES: readonly (readonly [string, CodeFileType])[] = [
  ['.component.ts', 'angular'],
  ['.component.html', 'angular'],
  ['.directive.ts', 'angular'],
  ['.service.ts', 'angular'],
  ['.module.ts', 'angular'],
  ['.pipe.ts', 'angular'],
  ['.guard.ts', 'angular'],
  ['.interceptor.ts', 'angular'],
  ['.dockerfile', 'docker'],
]

const EXTENSION_TYPES: Readonly<Record<string, CodeFileType>> = {
  'bash': 'shell',
  'c': 'c',
  'c++': 'cpp',
  'cc': 'cpp',
  'cfg': 'ini',
  'cjs': 'javascript',
  'clj': 'clojure',
  'cljc': 'clojure',
  'cljs': 'clojure',
  'cmake': 'cmake',
  'cpp': 'cpp',
  'cs': 'csharp',
  'csh': 'shell',
  'css': 'css',
  'csx': 'csharp',
  'cts': 'typescript',
  'cxx': 'cpp',
  'dart': 'dart',
  'dtd': 'xml',
  'edn': 'clojure',
  'env': 'env',
  'erl': 'erlang',
  'es6': 'javascript',
  'escript': 'erlang',
  'ex': 'elixir',
  'exs': 'elixir',
  'fish': 'shell',
  'gemspec': 'ruby',
  'go': 'go',
  'gql': 'graphql',
  'graphql': 'graphql',
  'h': 'c',
  'h++': 'cpp',
  'hh': 'cpp',
  'hpp': 'cpp',
  'hrl': 'erlang',
  'hs': 'haskell',
  'hxx': 'cpp',
  'ini': 'ini',
  'ipp': 'cpp',
  'java': 'java',
  'js': 'javascript',
  'json': 'json',
  'json5': 'json',
  'jsonc': 'json',
  'jsx': 'react',
  'ksh': 'shell',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'lhs': 'haskell',
  'lua': 'lua',
  'm': 'objective-c',
  'mak': 'makefile',
  'mjs': 'javascript',
  'mk': 'makefile',
  'mm': 'objective-c',
  'mts': 'typescript',
  'node': 'node',
  'pch': 'objective-c',
  'php': 'php',
  'php3': 'php',
  'php4': 'php',
  'php5': 'php',
  'phps': 'php',
  'phtml': 'php',
  'pl': 'perl',
  'plist': 'xml',
  'pm': 'perl',
  'pod': 'perl',
  'proto': 'protobuf',
  'ps1': 'powershell',
  'psd1': 'powershell',
  'psm1': 'powershell',
  'py': 'python',
  'pyi': 'python',
  'pyw': 'python',
  'pyx': 'python',
  'r': 'r',
  'rake': 'ruby',
  'rb': 'ruby',
  'rmd': 'r',
  'rs': 'rust',
  'sc': 'scala',
  'scala': 'scala',
  'sh': 'shell',
  'sol': 'solidity',
  'sql': 'sql',
  'svelte': 'svelte',
  'swift': 'swift',
  't': 'perl',
  'tcsh': 'shell',
  'toml': 'toml',
  'tpp': 'cpp',
  'ts': 'typescript',
  'tsx': 'react',
  'vue': 'vue',
  'wasm': 'wasm',
  'wast': 'wasm',
  'wat': 'wasm',
  'xml': 'xml',
  'xsd': 'xml',
  'xsl': 'xml',
  'xslt': 'xml',
  'yaml': 'yaml',
  'yml': 'yaml',
  'zig': 'zig',
  'zsh': 'shell',
}

const LINK_CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'cts',
  'mts',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'env',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'py',
  'pyi',
  'rb',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'cs',
  'php',
  'swift',
  'sql',
  'proto',
  'graphql',
  'gql',
  'lua',
  'r',
  'pl',
  'scala',
  'clj',
  'cljs',
  'ex',
  'exs',
  'erl',
  'hs',
  'dart',
])

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * The presentation categories a file-tree row can be drawn as: the forty-eight
 * detailed code types, plus the twelve coarse ones that share the sheet artwork.
 * A file's kind is what a *row* shows, so this is deliberately wider than
 * `CodeFileType` — `code`, `pdf` and `other` all have artwork of their own.
 */
export type FileType =
  | CodeFileType
  | 'code'
  | 'excel'
  | 'folder'
  | 'html'
  | 'image'
  | 'markdown'
  | 'other'
  | 'pdf'
  | 'ppt'
  | 'video'
  | 'word'

/** Every coarse category, i.e. `FileType` minus the detailed code types. */
type CoarseFileType = Exclude<FileType, CodeFileType>

/**
 * Extensions that name a presentation category rather than a language.
 *
 * The detailed code extensions are not repeated here — `classifyCodeFileType`
 * is asked first, and this table only has to know what is *not* code.
 */
const PRESENTATION_EXTENSION_TYPES: Readonly<Record<string, CoarseFileType>> = {
  scss: 'code',
  sass: 'code',
  less: 'code',
  vue: 'code',
  svelte: 'code',
  astro: 'code',
  bat: 'code',
  cmd: 'code',
  csv: 'excel',
  tsv: 'excel',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
  ppt: 'ppt',
  pptx: 'ppt',
  key: 'ppt',
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mpg: 'video',
  mpeg: 'video',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  odt: 'word',
  pages: 'word',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  xlsb: 'excel',
  xlt: 'excel',
  xltx: 'excel',
  xltm: 'excel',
  ods: 'excel',
  ots: 'excel',
  fods: 'excel',
  numbers: 'excel',
}

/** Extensionless files whose presentation category is their own name. */
const PRESENTATION_NAME_TYPES: Readonly<Record<string, CoarseFileType>> = {
  changelog: 'markdown',
  contributing: 'markdown',
  readme: 'markdown',
}

/**
 * The characters after the basename's final dot. A leading dot starts a suffix;
 * a missing or trailing dot yields the empty string, which no table has a key
 * for. Case is preserved — callers lowercase before looking a key up.
 */
export function fileExtension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

/**
 * Classify a file path or name for the file tree's per-row mark.
 *
 * Case-insensitive, and ordered: the detailed code rules get first refusal, so
 * `index.tsx` stays React rather than falling to the coarse sheet, then the
 * extensionless names, then the presentation extensions, then `other`.
 *
 * @param path - A file path or basename using either path separator.
 * @param context - Optional project files for context-sensitive code mappings.
 * @returns The category the row's mark is drawn from.
 */
export function classifyFileType(
  path: string,
  context?: FileTypeProjectContext,
): FileType {
  const name = basename(path).toLowerCase()
  const extension = fileExtension(name).toLowerCase()
  return (
    classifyCodeFileType(name, extension, context) ??
    PRESENTATION_NAME_TYPES[name] ??
    PRESENTATION_EXTENSION_TYPES[extension] ??
    'other'
  )
}

/**
 * Test whether a resolved file type uses the full-color code-icon set.
 * @param type - Resolved file-type string.
 * @returns Whether the value is a detailed code-file type.
 */
export function isCodeFileType(type: string): type is CodeFileType {
  return CODE_FILE_TYPE_SET.has(type)
}

/**
 * Test whether an extension belongs to the established coarse link-icon code category.
 * @param extension - Extension without a leading dot.
 * @returns Whether clickable links keep the code glyph for this extension.
 */
export function isLinkCodeExtension(extension: string): boolean {
  return LINK_CODE_EXTENSIONS.has(extension.toLowerCase())
}

/**
 * Resolve the most specific code/configuration icon according to the supplied map priority.
 * @param name - Lowercase basename.
 * @param extension - Lowercase extension without the leading dot.
 * @param context - Optional project-file snapshot for context-sensitive matches.
 * @returns The detailed code type, or null when the traditional file classifier owns the path.
 */
export function classifyCodeFileType(
  name: string,
  extension: string,
  context?: FileTypeProjectContext,
): CodeFileType | null {
  const exact = FILE_NAME_TYPES[name]
  if (exact !== undefined) return exact
  for (const [prefix, type] of FILE_NAME_PREFIX_TYPES) {
    if (name.startsWith(prefix)) return type
  }
  for (const [suffix, type] of FILE_NAME_SUFFIX_TYPES) {
    if (name.endsWith(suffix)) return type
  }
  if (extension === 'dart' && context !== undefined) {
    const pubspec = Object.entries(context.files).find(([path]) => basename(path).toLowerCase() === 'pubspec.yaml')?.[1]
    if (pubspec?.includes('flutter:') === true) return 'flutter'
  }
  return EXTENSION_TYPES[extension] ?? null
}
