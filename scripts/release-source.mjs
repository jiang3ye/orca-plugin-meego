import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const mode = process.argv[2]
if (!['--check', '--export'].includes(mode) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/release-source.mjs --check|--export')
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== realpathSync(root)) {
  throw new Error('Run release checks from a Git repository rooted at this project.')
}
const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const manifest = readJson('orca-plugin.json')
const project = readJson('package.json')
if (manifest.version !== project.version) {
  throw new Error('Package and plugin versions differ.')
}
if (project.private !== true) {
  throw new Error('Development tooling must remain private to npm.')
}
if (manifest.publisher !== undefined) {
  throw new Error('Orca derives the publisher from the repository owner.')
}

const rootFiles = new Set([
  '.gitattributes',
  '.gitignore',
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'orca-plugin.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json'
])
const directories = new Set(['.github', 'docs', 'scripts', 'src', 'types'])
const files = git('ls-files', '-z').split('\0').filter(Boolean)
const hashes = {}
for (const file of files) {
  const parts = file.split('/')
  if (
    !(parts.length === 1 ? rootFiles.has(file) : directories.has(parts[0])) ||
    parts.some((part) => ['.git', '.orca', '.zcode', 'node_modules', 'artifacts'].includes(part)) ||
    /(?:^|\/)\.env(?:\.|$)|\.(?:pem|p12|keychain-db)$/.test(file) ||
    file.startsWith('docs/plans/')
  ) {
    throw new Error(`Private or unexpected file in release source: ${file}`)
  }
  const path = join(root, ...parts)
  if (!lstatSync(path).isFile()) {
    throw new Error(`Release source must be a regular file: ${file}`)
  }
  hashes[file] = createHash('sha256').update(readFileSync(path)).digest('hex')
}
for (const file of [
  'orca-plugin.json',
  'LICENSE',
  'README.md',
  'package-lock.json',
  manifest.main,
  ...manifest.contributes.panels.map((panel) => panel.entry)
]) {
  if (!files.includes(file)) {
    throw new Error(`Required release file is not tracked: ${file}`)
  }
}

console.log(`Source inventory passed: ${files.length} tracked files; plugin v${manifest.version}.`)
if (mode === '--export') {
  if (git('status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Commit the reviewed source before exporting a release snapshot.')
  }
  const commit = git('rev-parse', 'HEAD').trim()
  const destination = join(
    root,
    '.orca',
    'release',
    `${project.name}-${manifest.version}-${commit.slice(0, 12)}`
  )
  if (existsSync(destination)) {
    throw new Error(`Release snapshot already exists: ${destination}`)
  }
  const source = join(destination, 'source')
  for (const file of files) {
    const target = join(source, ...file.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(root, ...file.split('/')), target)
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hashes[file]) {
      throw new Error(`Source changed during export: ${file}`)
    }
  }
  if (
    git('rev-parse', 'HEAD').trim() !== commit ||
    git('status', '--porcelain', '--untracked-files=normal')
  ) {
    throw new Error('The repository changed during export; discard this snapshot.')
  }
  writeFileSync(
    join(destination, 'source-receipt.json'),
    `${JSON.stringify(
      {
        version: manifest.version,
        developmentCommit: commit,
        publicHostCompatibility: 'unverified; see docs/releasing.md before publishing',
        files: hashes
      },
      null,
      2
    )}\n`
  )
  console.log(`Clean source snapshot: ${source}`)
  console.log(
    'No Git history, generated SDK cache, credentials, or live acceptance data were exported.'
  )
}
