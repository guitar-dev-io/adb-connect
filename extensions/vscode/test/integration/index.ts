import * as vscode from 'vscode'
import assert from 'assert'
import fs from 'fs'

type Snapshot = ReturnType<
  import('../../src/controller').Controller['snapshot']
>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(
  fn: () => T | undefined | false,
  label: string,
  timeout = 15_000,
): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await sleep(100)
  }
}

export async function run(): Promise<void> {
  const results: [string, string | null][] = []
  const t = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
      results.push([name, null])
    } catch (e) {
      results.push([name, String((e as Error).stack ?? e)])
    }
  }

  const ext = vscode.extensions.all.find(
    (e) => e.packageJSON.name === 'adb-connect-vscode',
  )!
  const api = (await ext.activate()) as {
    controller: {
      snapshot(): Snapshot
      deviceOp(op: string, id: string): Promise<void>
    }
  }
  const snap = () => api.controller.snapshot()

  await t('activates and finds adb from settings', async () => {
    const s = await until(() => snap().adb && snap(), 'engine')
    assert.equal(s.adb!.version.platformTools, '37.0.1')
    assert.equal(s.error, undefined)
  })

  await t('tracks USB device and discovers advertised device', async () => {
    const s = await until(() => {
      const x = snap()
      return x.entries.length >= 2 && x
    }, 'entries')
    const usb = s.entries.find((e) => e.serial === 'R58N12345AB')!
    assert.equal(usb.status, 'connected')
    assert.equal(usb.name, 'Galaxy S24')
    const adv = s.entries.find((e) => e.endpoint === '192.168.1.45:37123')!
    assert.equal(adv.status, 'available')
    assert.equal(adv.known, false, 'never auto-connected')
  })

  await t('all quick-action commands are registered', async () => {
    const cmds = await vscode.commands.getCommands(true)
    for (const id of [
      'menu',
      'connect',
      'reconnect',
      'disconnect',
      'pairQr',
      'pairCode',
      'discover',
      'devices',
      'settings',
      'logs',
    ]) {
      assert.ok(cmds.includes(`adbConnect.${id}`), id)
    }
  })

  await t('device manager opens', async () => {
    await vscode.commands.executeCommand('adbConnect.devices')
    await until(
      () =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .some((tab) => tab.label.includes('ADB Connect')),
      'manager tab',
    )
  })

  await t(
    'unknown advertised device was not connected automatically',
    async () => {
      await sleep(1500)
      const calls = fs
        .readFileSync(process.env.ADBC_FAKE_LOG!, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
      assert.equal(calls.filter((c) => c[0] === 'connect').length, 0)
      assert.ok(
        calls.some((c) => c[0] === 'track-devices'),
        'uses event-driven tracking',
      )
    },
  )

  await t(
    'manual connect to the advertised endpoint remembers the device',
    async () => {
      const adv = await until(
        () =>
          snap().entries.find(
            (e) => e.endpoint === '192.168.1.45:37123' && !e.known,
          ),
        'advertised, not yet known',
      )
      await api.controller.deviceOp('connect', adv.id)
      const known = await until(
        () =>
          snap().entries.find(
            (e) =>
              e.endpoint === '192.168.1.45:37123' &&
              e.known &&
              e.status === 'connected',
          ),
        'advertised device became known and connected',
      )
      assert.equal(known.known, true)
      assert.equal(known.status, 'connected')
    },
  )

  await t(
    'preferredDevice selection is reflected in the snapshot',
    async () => {
      const dev = await until(
        () =>
          snap().entries.find(
            (e) => e.endpoint === '192.168.1.45:37123' && e.known,
          ),
        'known wireless device',
      )
      await vscode.workspace
        .getConfiguration('adbConnect')
        .update('preferredDevice', dev.id, vscode.ConfigurationTarget.Global)
      const preferred = await until(() => {
        const e = snap().entries.find((x) => x.id === dev.id)
        return e?.preferred ? e : undefined
      }, 'device marked preferred')
      assert.equal(preferred.preferred, true)
      assert.equal(
        snap().entries.filter((e) => e.preferred).length,
        1,
        'exactly one preferred device',
      )
      await vscode.workspace
        .getConfiguration('adbConnect')
        .update('preferredDevice', '', vscode.ConfigurationTarget.Global)
    },
  )

  for (const [name, err] of results)
    console.log(`${err ? '✗' : '✓'} ${name}${err ? `\n${err}` : ''}`)
  const failed = results.filter((r) => r[1]).length
  if (failed) throw new Error(`${failed} integration test(s) failed`)
}
