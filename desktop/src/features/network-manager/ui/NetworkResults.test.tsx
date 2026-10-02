import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { createNetworkFixture } from '../testing/networkFixture'
import { NetworkResults } from './NetworkResults'

afterEach(cleanup)
it('distinguishes configured state from a successful probe and shows its source and timestamp', () => {
  useSettingsStore.setState({ locale: 'en' })
  const fixture = createNetworkFixture()
  const { rerender } = render(<NetworkResults snapshot={fixture.snapshot} plan={fixture.plan} report={null} probes={[]} />)
  expect(screen.queryByText('Verified')).toBeNull()
  expect(screen.getByText('VPN split tunneling or associated routes need changes')).toBeVisible()
  rerender(<NetworkResults snapshot={fixture.snapshot} plan={null} report={null} probes={[fixture.probe]} />)
  expect(screen.getByText('Verified')).toBeVisible()
  expect(screen.getByText('Source: 191.168.7.10 · Fixture Ethernet')).toBeVisible()
  expect(screen.getByText('Fixture TCP connected')).toBeVisible()
})

it('explains an applied local configuration with an unverified business endpoint', () => {
  useSettingsStore.setState({ locale: 'en' })
  render(<NetworkResults snapshot={null} plan={null} report={{ planId: 'plan', status: 'applied', completedChanges: [], rollback: [], probes: [], issues: ['BUSINESS_NOT_VERIFIED', 'PROXY_NOT_VERIFIED'] }} probes={[]} />)
  expect(screen.getByText(/Local configuration was restored, but at least one service endpoint failed/)).toBeVisible()
  expect(screen.getByText(/Local configuration was restored, but proxy verification failed/)).toBeVisible()
  expect(screen.queryByText('Verified')).toBeNull()
})

it('does not append a duplicate port to HTTP probe URLs', () => {
  useSettingsStore.setState({ locale: 'en' })
  const { probe } = createNetworkFixture()
  render(<NetworkResults snapshot={null} plan={null} report={null} probes={[{ ...probe, target: 'http://10.0.0.199:8070/', port: 8070, kind: 'http-direct' }]} />)
  expect(screen.getByText('http://10.0.0.199:8070/ · http-direct · 4 ms')).toBeVisible()
})

it('translates common diagnostic outcomes for Chinese users and retains the evidence code', () => {
  useSettingsStore.setState({ locale: 'zh' })
  const { probe } = createNetworkFixture()
  render(<NetworkResults snapshot={null} plan={null} report={null} probes={[{ ...probe, detail: 'TCP_CONNECTED' }, { ...probe, ok: false, detail: 'ROUTE_MISMATCH' }]} />)
  expect(screen.getByText('目标端点有响应 (TCP_CONNECTED)')).toBeVisible()
  expect(screen.getByText('未选中期望的网卡 (ROUTE_MISMATCH)')).toBeVisible()
})
