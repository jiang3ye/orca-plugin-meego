import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The CI SDK verifier requires macOS ARM64.')
}
const app = process.env.ORCA_CI_APP
if (!app) {
  throw new Error('ORCA_CI_APP must identify the downloaded SDK application.')
}
const source = process.env.ORCA_CI_SDK_SOURCE
if (!['companion', 'public'].includes(source)) {
  throw new Error('ORCA_CI_SDK_SOURCE must be companion or public.')
}
const appId = execFileSync(
  '/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')],
  { encoding: 'utf8' }
).trim()
if (appId !== 'com.stablyai.orca') {
  throw new Error('Downloaded application is not the Orca SDK host.')
}
if (source === 'companion') {
  const pin = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../.github/orca-sdk.json'), 'utf8')
  )
  const identity = JSON.parse(
    readFileSync(join(app, 'Contents/Resources/orca-local-build.json'), 'utf8')
  )
  if (
    identity.formatVersion !== 1 ||
    identity.appId !== 'com.stablyai.orca' ||
    identity.commit !== pin.hostCommit ||
    identity.version !== pin.version ||
    identity.platform !== 'darwin' ||
    identity.architecture !== 'arm64'
  ) {
    throw new Error('Companion SDK identity does not match the committed pin.')
  }
}

const { mockHost } = await import(
  pathToFileURL(
    join(app, 'Contents/Resources/app.asar.unpacked/resources/plugins/declarative/orca-testing.mjs')
  ).href
)
const host = mockHost({
  capabilities: ['agent:read', 'settings:own', 'workspace:read', 'workspace:write'],
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
