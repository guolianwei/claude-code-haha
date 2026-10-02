import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { createNetworkFixture } from '../testing/networkFixture'
import { createDefaultNetworkProfiles } from '../networkTypes'
import { VpnProfileSelector } from './VpnProfileSelector'
import { NetworkRecoveryStatus } from './NetworkRecoveryStatus'
import { NetworkStepEvidence } from './NetworkStepEvidence'
import { VerificationTargets } from './VerificationTargets'
import { matchesVerificationTarget, mergeNetworkProbes, probeBelongsToStep } from './networkEvidence'

beforeEach(() => useSettingsStore.setState({ locale: 'en' }))
afterEach(cleanup)

it('selects a renamed VPN by observed server and scope and preserves routing policy', async () => {
  const fixture = createNetworkFixture()
  fixture.api.vpnRouteOptions = vi.fn<typeof fixture.api.vpnRouteOptions>(async () => ({ ok: true, data: { vpns: [
    { name: 'Company', serverAddress: '124.114.142.77', scope: 'allUsers', connected: true, splitTunneling: false, routes: [] },
    { name: 'Company', serverAddress: '192.0.2.2', scope: 'currentUser', connected: false, splitTunneling: true, routes: [] },
  ] } }))
  const profile = createDefaultNetworkProfiles()[0]
  const onChange = vi.fn()
  render(<VpnProfileSelector api={fixture.api} profile={profile} disabled={false} onChange={onChange} />)
  await screen.findByRole('option', { name: 'Company · 124.114.142.77 · All users · Connected' })
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Existing Windows VPN connection'), { target: { value: JSON.stringify(['allUsers', 'Company']) } })
  expect(onChange).toHaveBeenCalledWith({ ...profile, vpnName: 'Company', vpnServerAddress: '124.114.142.77', vpnScope: 'allUsers', splitTunnelingPolicy: 'preserve' })
  expect(screen.getByLabelText('VPN routing policy')).toHaveValue('preserve')
})

it('distinguishes a failed VPN enumeration from a missing connection and allows retry', async () => {
  const fixture = createNetworkFixture()
  fixture.api.vpnRouteOptions = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue({ ok: true, data: { vpns: [] } })
  render(<VpnProfileSelector api={fixture.api} profile={createDefaultNetworkProfiles()[0]} disabled={false} onChange={vi.fn()} />)
  await screen.findByText(/VPN connections could not be read/)
  expect(screen.queryByText(/saved connection was not found/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh VPN connections' }))
  await screen.findByText(/saved connection was not found/)
})

it('keeps a Running task separate from relay, tunnel and business readiness', () => {
  const fixture = createNetworkFixture()
  fixture.snapshot.tunnel = { ...fixture.snapshot.tunnel, taskRunning: true, relayReady: false, udpListening: false, tcpConnected: false }
  const { rerender } = render(<NetworkRecoveryStatus profile={createDefaultNetworkProfiles()[0]} snapshot={fixture.snapshot} probes={[]} />)
  expect(within(screen.getByTestId('recovery-task')).getByText('Confirmed')).toBeVisible()
  expect(within(screen.getByTestId('recovery-relay')).getByText('Needs attention')).toBeVisible()
  expect(within(screen.getByTestId('recovery-tunnel')).getByText('Not confirmed')).toBeVisible()
  expect(within(screen.getByTestId('recovery-business')).getByText('Not confirmed')).toBeVisible()
  expect(within(screen.getByTestId('recovery-relay')).getByText('Needs attention')).toHaveClass('bg-[var(--color-error-container)]')
  rerender(<NetworkRecoveryStatus profile={createDefaultNetworkProfiles()[0]} snapshot={fixture.snapshot} probes={[]} applying />)
  expect(within(screen.getByTestId('recovery-relay')).getByText('Starting — waiting for readiness')).toHaveClass('bg-[var(--color-surface-container)]')
  expect(within(screen.getByTestId('recovery-relay')).getByText('Starting — waiting for readiness')).not.toHaveClass('bg-[var(--color-warning-container)]')
})

it('shows collecting errors as unknown rather than a missing task', () => {
  const fixture = createNetworkFixture()
  fixture.snapshot.tunnel.taskStatus = 'unknown'
  fixture.snapshot.tunnel.taskRunning = false
  render(<NetworkRecoveryStatus profile={createDefaultNetworkProfiles()[0]} snapshot={fixture.snapshot} probes={[]} />)
  expect(within(screen.getByTestId('recovery-task')).getByText('Not confirmed')).toBeVisible()
})

it('only verifies business against the configured protocol, port and address', () => {
  const fixture = createNetworkFixture()
  const profile = { ...createDefaultNetworkProfiles()[0], verificationTargets: [{ id: 'web', label: 'Workbench', address: '10.0.0.199', port: 8070, protocol: 'http' as const }] }
  const probe = { ...fixture.probe, target: '10.0.0.199', port: 8070 }
  const { rerender } = render(<NetworkRecoveryStatus profile={profile} snapshot={fixture.snapshot} probes={[probe]} />)
  expect(within(screen.getByTestId('recovery-business')).getByText('Not confirmed')).toBeVisible()
  rerender(<NetworkRecoveryStatus profile={profile} snapshot={fixture.snapshot} probes={[{ ...probe, target: 'http://10.0.0.199:8070/', kind: 'http-direct', statusCode: 200 }]} />)
  expect(within(screen.getByTestId('recovery-business')).getByText('Confirmed')).toBeVisible()
})

it('shows the failed link, its route and the fields to review', () => {
  const fixture = createNetworkFixture()
  fixture.snapshot.tunnel.readinessIssues = ['RELAY_NOT_READY']
  render(<NetworkStepEvidence step="relay" profile={createDefaultNetworkProfiles()[0]} snapshot={fixture.snapshot} />)
  expect(screen.getByText(/RELAY_NOT_READY/)).toBeVisible()
  expect(screen.getByText(/191.168.7.62 → Fixture Ethernet/)).toBeVisible()
  expect(screen.getByText(/compare the local UDP port, gateway TCP port and expected outer source/)).toBeVisible()
})

it('retains other layers when a link is rechecked and replaces matching old evidence', () => {
  const fixture = createNetworkFixture()
  const profile = createDefaultNetworkProfiles()[0]
  const host = { ...fixture.probe, target: profile.gatewayAddress, port: profile.gatewayPort }
  const relay = { ...fixture.probe, kind: 'relay' as const, target: profile.relayTaskName, ok: false }
  const nextRelay = { ...relay, ok: true, checkedAt: '2026-10-02T00:00:00.000Z' }
  expect(mergeNetworkProbes([host, relay], [nextRelay])).toEqual([host, nextRelay])
  expect(probeBelongsToStep(host, 'relay', profile)).toBe(false)
  expect(probeBelongsToStep(nextRelay, 'relay', profile)).toBe(true)
  expect(matchesVerificationTarget({ ...host, target: 'https://10.0.0.199:8070/', kind: 'http-direct' }, { address: '10.0.0.199', port: 8070, protocol: 'http' })).toBe(false)
})

it('edits manual endpoints without requiring a managed login host', () => {
  const profile = { ...createDefaultNetworkProfiles()[0], containerEnabled: false, verificationTargets: [{ id: 'web', label: '', address: '10.0.0.199', port: 8070, protocol: 'http' as const }] }
  const onChange = vi.fn(), onVerify = vi.fn()
  render(<VerificationTargets profile={profile} disabled={false} onChange={onChange} onVerify={onVerify} />)
  fireEvent.change(screen.getByLabelText('Service port'), { target: { value: '8080' } })
  expect(onChange).toHaveBeenCalledWith({ ...profile, verificationTargets: [{ ...profile.verificationTargets[0], port: 8080 }] })
  fireEvent.click(screen.getByRole('button', { name: 'Check configured service endpoints' }))
  expect(onVerify).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Add service endpoint' }))
  expect(onChange.mock.lastCall?.[0].verificationTargets).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Remove endpoint' }))
  expect(onChange).toHaveBeenLastCalledWith({ ...profile, verificationTargets: [] })
})

it('points an out-of-subnet endpoint to the container prefix setting before verification', () => {
  const profile = { ...createDefaultNetworkProfiles()[0], verificationTargets: [{ id: 'web', label: '', address: '10.0.0.199', port: 8070, protocol: 'http' as const }] }
  render(<VerificationTargets profile={profile} disabled={false} onChange={vi.fn()} onVerify={vi.fn()} />)
  expect(screen.getByText(/outside the configured container subnet/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Check configured service endpoints' })).toBeDisabled()
})
