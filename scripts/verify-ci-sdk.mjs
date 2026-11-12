import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.env.ORCA_CI_SDK_SOURCE
let testingKit
if (source === 'source') {
  const hostRoot = process.env.ORCA_CI_HOST_ROOT
  if (!hostRoot) {
    throw new Error('ORCA_CI_HOST_ROOT must identify the pinned host checkout.')
  }
  const pin = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../.github/orca-sdk.json'), 'utf8')
  )
  const commit = execFileSync('git', ['-C', hostRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
  const output = JSON.parse(readFileSync(join(hostRoot, 'out/package.json'), 'utf8'))
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || commit !== pin.commit || output.commit !== pin.commit) {
    throw new Error('Source checkout or compiled CLI does not match the committed SDK pin.')
  }
  execFileSync('git', ['-C', hostRoot, 'diff', '--quiet', 'HEAD'], { windowsHide: true })
  testingKit = join(hostRoot, 'resources/plugins/declarative/orca-testing.mjs')
} else if (source === 'public') {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The public release SDK verifier requires macOS ARM64.')
  }
  const app = process.env.ORCA_CI_APP
  if (!app) {
    throw new Error('ORCA_CI_APP must identify the downloaded SDK application.')
  }
  const appId = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')],
    { encoding: 'utf8' }
  ).trim()
  if (appId !== 'com.stablyai.orca') {
    throw new Error('Downloaded application is not the Orca SDK host.')
  }
  testingKit = join(
    app,
    'Contents/Resources/app.asar.unpacked/resources/plugins/declarative/orca-testing.mjs'
  )
} else {
  throw new Error('ORCA_CI_SDK_SOURCE must be source or public.')
}

const { mockHost } = await import(pathToFileURL(testingKit).href)
const host = mockHost({
  capabilities: ['agent:read', 'settings:own', 'workspace:read', 'workspace:write', 'workspace:create'],
  results: { 'settings.open': { opened: true }, 'agents.available': { agents: [] } }
})
for (const method of ['settings.open', 'agents.available', 'workspace.create']) {
  if (!host.worker.has(method)) {
    throw new Error(`The authoring SDK does not recognize required host method ${method}.`)
  }
}
await host.worker.call('settings.open')
await host.worker.call('agents.available', { workspaceId: 'ci-workspace' })
console.log('SDK identity and required host method contracts verified.')
