// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

vi.mock('@cloudflare/kumo', () => {
  // The mock factory is hoisted, so its component must be declared here.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const Select = ({ label, value, onValueChange, children }: {
    label: string, value: string, onValueChange: (value: string) => void, children: ReactNode,
  }) => <label>{label}<select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select></label>
  Select.Option = ({ value, children }: { value: string, children: ReactNode }) => <option value={value}>{children}</option>
  return {
    Select,
    Button: ({ children, onClick, disabled }: { children: ReactNode, onClick: () => void, disabled?: boolean }) =>
      <button onClick={onClick} disabled={disabled}>{children}</button>,
    Checkbox: ({ label, checked, onCheckedChange }: { label: string, checked: boolean, onCheckedChange: (value: boolean) => void }) =>
      <label><input type="checkbox" checked={checked} onChange={event => onCheckedChange(event.target.checked)} />{label}</label>,
  }
})

import { ChatGptConnectionPanel } from './ChatGptConnectionPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

const click = async (element: HTMLElement) => { await act(async () => element.click()) }

const makeApi = (connected = false) => ({
  getChatGptStatus: vi.fn<AuthenticatedApi['getChatGptStatus']>(async () => ({ available: true, connected })),
  listChatGptModels: vi.fn<AuthenticatedApi['listChatGptModels']>(async () => [{ slug: 'gpt-test', displayName: 'GPT Test' }]),
  startChatGptLogin: vi.fn<AuthenticatedApi['startChatGptLogin']>(async () => ({ url: 'https://auth.openai.com/api/accounts/authorize' })),
  disconnectChatGpt: vi.fn<AuthenticatedApi['disconnectChatGpt']>(async () => ({ revoked: true })),
  addModel: vi.fn<AuthenticatedApi['addModel']>(async () => {}),
  setQuickModel: vi.fn<AuthenticatedApi['setQuickModel']>(async () => {}),
  setPreferredModel: vi.fn<AuthenticatedApi['setPreferredModel']>(async () => {}),
})

describe('ChatGptConnectionPanel', () => {
  let root: Root | undefined
  const onModelAdded = vi.fn<() => void>()
  const render = async (api: ReturnType<typeof makeApi>) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<ChatGptConnectionPanel
      authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}
      onModelAdded={onModelAdded}
    />))
  }
  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
    onModelAdded.mockClear()
  })

  it('explains local-only availability without offering login or requesting a catalog', async () => {
    const api = makeApi()
    api.getChatGptStatus.mockResolvedValue({ available: false, connected: false })
    await render(api)
    expect(document.body.textContent).toContain('pnpm run-local --chatgpt')
    expect(document.body.textContent).not.toContain('Continue with ChatGPT')
    expect(api.listChatGptModels).not.toHaveBeenCalled()
  })

  it('does not start a login when the popup was blocked', async () => {
    const api = makeApi()
    vi.spyOn(window, 'open').mockReturnValue(null)
    await render(api)
    await click(button('Continue with ChatGPT'))
    expect(api.startChatGptLogin).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('popup was blocked')
  })

  it('refreshes connection and catalog after closing the popup', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const popup = { closed: false, close: vi.fn<() => void>(), location: { href: '' }, opener: window }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await render(api)
    await click(button('Continue with ChatGPT'))
    expect(popup.location.href).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(popup.opener).toBeNull()
    api.getChatGptStatus.mockResolvedValue({ available: true, connected: true })
    popup.closed = true
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.listChatGptModels).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('ChatGPT connected')
    expect(button('Add ChatGPT model').disabled).toBe(false)
  })

  it('reports cancellation without inventing a successful connection', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const popup = { closed: false, close: vi.fn<() => void>(), location: { href: '' }, opener: null }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await render(api)
    await click(button('Continue with ChatGPT'))
    popup.closed = true
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(document.body.textContent).toContain('Sign-in did not complete')
    expect(api.listChatGptModels).not.toHaveBeenCalled()
  })

  it('adds a credential-free model and applies explicit preferred and title-model choices', async () => {
    const api = makeApi(true)
    await render(api)
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await click(input)
    await click(button('Add ChatGPT model'))
    expect(api.addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'chatgpt:gpt-test', name: 'GPT Test (ChatGPT)' },
      { provider: 'openai', model: 'gpt-test', apiToken: '', authentication: 'chatgpt' },
    )
    expect(api.setPreferredModel).toHaveBeenCalledWith('chatgpt:gpt-test')
    expect(api.setQuickModel).toHaveBeenCalledWith('chatgpt:gpt-test')
    expect(onModelAdded).toHaveBeenCalledOnce()
  })

  it('keeps partial-save errors visible instead of closing the dialog', async () => {
    const api = makeApi(true)
    api.setQuickModel.mockRejectedValue(new Error('offline'))
    await render(api)
    await click(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1])
    await click(button('Add ChatGPT model'))
    expect(api.addModel).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('model was added')
    expect(onModelAdded).not.toHaveBeenCalled()
  })

  it('reports disconnect failure and retains the current connection', async () => {
    const api = makeApi(true)
    api.disconnectChatGpt.mockRejectedValue(new Error('offline'))
    await render(api)
    await click(button('Disconnect ChatGPT'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('may still be active')
    expect(document.body.textContent).toContain('Connected to ChatGPT')
  })

  it('does not fetch a catalog when subscription sharing is disabled', async () => {
    const api = makeApi(true)
    api.getChatGptStatus.mockResolvedValue({ available: true, connected: true, email: 'owner@example.test', sharingEnabled: false })
    await render(api)
    expect(document.body.textContent).toContain('owner@example.test')
    expect(document.body.textContent).toContain('subscription sharing is not enabled')
    expect(api.listChatGptModels).not.toHaveBeenCalled()
  })

  it('warns when local disconnect did not confirm remote revocation', async () => {
    const api = makeApi(true)
    api.disconnectChatGpt.mockResolvedValue({ revoked: false })
    await render(api)
    api.getChatGptStatus.mockResolvedValue({ available: true, connected: false })
    await click(button('Disconnect ChatGPT'))
    expect(document.body.textContent).toContain('remote revocation could not be confirmed')
    expect(document.querySelector('select')).toBeNull()
  })

  it('rejects an unexpected login destination before navigating the popup', async () => {
    const api = makeApi()
    api.startChatGptLogin.mockResolvedValue({ url: 'https://example.test/authorize' })
    const popup = { closed: false, close: vi.fn<() => void>(), location: { href: '' }, opener: null }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await render(api)
    await click(button('Continue with ChatGPT'))
    expect(popup.location.href).toBe('')
    expect(popup.close).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not start')
  })

  it('clears stale choices when refreshing status fails', async () => {
    const api = makeApi(true)
    await render(api)
    api.getChatGptStatus.mockRejectedValue(new Error('offline'))
    await click(button('Refresh connection'))
    expect(document.querySelector('select')).toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh')
  })

  it('closes the popup and stops watching it when the panel unmounts', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const popup = { closed: false, close: vi.fn<() => void>(), location: { href: '' }, opener: null }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await render(api)
    await click(button('Continue with ChatGPT'))
    act(() => { root!.unmount(); root = undefined })
    popup.closed = true
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(popup.close).toHaveBeenCalledOnce()
    expect(api.getChatGptStatus).toHaveBeenCalledOnce()
  })

  it('reports catalog failure without offering stale choices', async () => {
    const api = makeApi(true)
    await render(api)
    api.listChatGptModels.mockRejectedValue(new Error('offline'))
    await click(button('Refresh connection'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh')
    expect(document.querySelector('select')).toBeNull()
  })
})
