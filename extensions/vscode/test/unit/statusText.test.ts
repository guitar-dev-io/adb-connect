import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeviceEntry } from '@adb-connect/core'
import { statusText } from '../../src/statusText'

const entry = (over: Partial<DeviceEntry>): DeviceEntry => ({
  id: 'x',
  name: 'Pixel 9 Pro',
  transport: 'wifi',
  status: 'connected',
  known: true,
  paired: true,
  preferred: false,
  ...over,
})

test('status bar text matches the spec states', () => {
  assert.equal(
    statusText({ activity: 'idle', entries: [] }).text,
    '$(device-mobile) ADB: Disconnected',
  )
  assert.equal(
    statusText({ activity: 'searching', entries: [] }).text,
    '$(search) ADB: Searching...',
  )
  assert.equal(
    statusText({ activity: 'idle', entries: [entry({})] }).text,
    '$(device-mobile) ADB: Pixel 9 Pro',
  )
  assert.equal(
    statusText({
      activity: 'idle',
      entries: [
        entry({ id: 'a' }),
        entry({ id: 'b', name: 'Galaxy S24', transport: 'usb' }),
      ],
    }).text,
    '$(device-mobile) ADB: 2 Devices Connected',
  )
  assert.equal(
    statusText({ activity: 'reconnecting', entries: [] }).text,
    '$(sync~spin) ADB: Reconnecting...',
  )
  assert.equal(
    statusText({ activity: 'no-adb', entries: [] }).text,
    '$(warning) ADB: Not found',
  )
})

test('searching does not hide a connected device', () => {
  assert.equal(
    statusText({ activity: 'searching', entries: [entry({})] }).text,
    '$(device-mobile) ADB: Pixel 9 Pro',
  )
})

test('preferred device drives active selection: single-device text and tooltip order', () => {
  const a = entry({
    id: 'a',
    name: 'Pixel 9 Pro',
    endpoint: '192.168.1.10:5555',
  })
  const b = entry({
    id: 'b',
    name: 'Galaxy S24',
    serial: 'R58N',
    transport: 'usb',
  })
  // Spec-fixed text: two connected devices show the count, never the preferred name.
  assert.equal(
    statusText({ activity: 'idle', entries: [a, b], preferredId: 'b' }).text,
    '$(device-mobile) ADB: 2 Devices Connected',
  )
  // The preferred device is selected as active on the single-device text path.
  assert.equal(
    statusText({ activity: 'idle', entries: [b], preferredId: 'b' }).text,
    '$(device-mobile) ADB: Galaxy S24',
  )
  // With the second device preferred, it leads the tooltip (active device first).
  const lines = statusText({
    activity: 'idle',
    entries: [a, b],
    preferredId: 'b',
  }).tooltip.split('\n')
  assert.match(lines[0], /^Galaxy S24 /, 'preferred device is listed first')
  assert.match(lines[1], /^Pixel 9 Pro /)
})

test('tooltip lists every connected device with address and transport', () => {
  const t = statusText({
    activity: 'idle',
    entries: [
      entry({ endpoint: '192.168.1.45:37123' }),
      entry({ id: 'u', name: 'Galaxy', serial: 'R58N', transport: 'usb' }),
      entry({ id: 'd', status: 'disconnected' }),
    ],
  }).tooltip
  assert.match(t, /Pixel 9 Pro — 192\.168\.1\.45:37123 \(Wi-Fi\)/)
  assert.match(t, /Galaxy — R58N \(USB\)/)
  assert.ok(!t.includes('disconnected'))
})
