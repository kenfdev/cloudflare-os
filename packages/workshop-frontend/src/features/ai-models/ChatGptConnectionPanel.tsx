import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Select } from '@cloudflare/kumo'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

type Status = Awaited<ReturnType<AuthenticatedApi['getChatGptStatus']>>
type Models = Awaited<ReturnType<AuthenticatedApi['listChatGptModels']>>

export const ChatGptConnectionPanel = ({ authenticatedApi, onModelAdded }: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  onModelAdded: () => void
}) => {
  const [status, setStatus] = useState<Status | null>(null)
  const [models, setModels] = useState<Models>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preferred, setPreferred] = useState(false)
  const [quick, setQuick] = useState(false)
  const request = useRef(0)
  const popup = useRef<Window | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const mounted = useRef(false)

  const stopWaiting = () => {
    clearInterval(timer.current)
    timer.current = undefined
    setWaiting(false)
  }

  const refresh = async (afterLogin = false) => {
    const current = ++request.current
    setModels([])
    try {
      const next = await authenticatedApi.getChatGptStatus()
      if (!mounted.current || current !== request.current) return
      setStatus(next)
      const catalog = next.connected && next.sharingEnabled !== false ? await authenticatedApi.listChatGptModels() : []
      if (!mounted.current || current !== request.current) return
      setModels(catalog)
      setSelected(value => catalog.some(model => model.slug === value) ? value : catalog[0]?.slug ?? '')
      setError(next.error ?? '')
      if (afterLogin) {
        stopWaiting()
        setNotice(next.connected ? 'ChatGPT connected. Choose a model below.' : 'Sign-in did not complete. You can try again.')
      }
    } catch {
      if (mounted.current && current === request.current) {
        setError('Could not refresh ChatGPT. Check that the local broker is running, then try again.')
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      ++request.current
      clearInterval(timer.current)
      popup.current?.close()
    }
  }, [authenticatedApi])

  const connect = async () => {
    setError('')
    setNotice('')
    // Open during the click, before awaiting RPC, so browser popup blockers permit it.
    const opened = window.open('about:blank', '_blank', 'popup,width=600,height=760')
    if (!opened) {
      setError('The sign-in popup was blocked. Allow popups for this site and try again.')
      return
    }
    popup.current = opened
    opened.opener = null
    setBusy(true)
    try {
      const { url } = await authenticatedApi.startChatGptLogin()
      if (!mounted.current) { opened.close(); return }
      const destination = new URL(url)
      if (destination.origin !== 'https://auth.openai.com' || destination.pathname !== '/api/accounts/authorize' || destination.username || destination.password) {
        throw new Error('Invalid sign-in URL')
      }
      opened.location.href = destination.href
      setWaiting(true)
      const started = Date.now()
      timer.current = setInterval(() => {
        if (opened.closed) {
          stopWaiting()
          void refresh(true)
        } else if (Date.now() - started > 5 * 60 * 1000) {
          stopWaiting()
          setNotice('Sign-in is taking longer than expected. Finish in the popup, then refresh the connection.')
        }
      }, 1000)
    } catch {
      opened.close()
      if (mounted.current) setError('Could not start ChatGPT sign-in. Check the local broker and try again.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError('')
    try {
      const { revoked } = await authenticatedApi.disconnectChatGpt()
      if (!mounted.current) return
      stopWaiting()
      popup.current?.close()
      setNotice(revoked
        ? 'ChatGPT disconnected. Saved ChatGPT models require reconnecting before use.'
        : 'Local ChatGPT credentials were cleared, but remote revocation could not be confirmed. Review connected apps in ChatGPT Settings. Saved ChatGPT models require reconnecting before use.')
      await refresh()
    } catch {
      if (mounted.current) setError('Could not disconnect ChatGPT. The connection may still be active. Refresh and try again.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const addModel = async () => {
    const model = models.find(item => item.slug === selected)
    if (!model) return
    setBusy(true)
    setError('')
    let added = false
    try {
      const id = `chatgpt:${model.slug}`
      await authenticatedApi.addModel({ type: 'agent', id, name: `${model.displayName} (ChatGPT)` }, {
        provider: 'openai', model: model.slug, apiToken: '', authentication: 'chatgpt',
      })
      added = true
      if (preferred) await authenticatedApi.setPreferredModel(id)
      if (quick) await authenticatedApi.setQuickModel(id)
      if (mounted.current) {
        setNotice('ChatGPT model added.')
        onModelAdded()
      }
    } catch {
      if (mounted.current) setError(added
        ? 'The model was added, but its preferred or quick setting could not be saved. Update it from the model list.'
        : 'Could not add this ChatGPT model. Refresh the connection and try again; it may already be in your model list.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section aria-label="ChatGPT connection" className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
      <div>
        <h2 className="text-sm font-semibold text-kumo-default">ChatGPT</h2>
        <p className="text-sm text-kumo-subtle">Use your ChatGPT account through the local broker. No API key or client credentials to paste.</p>
      </div>
      <p role="status" className="text-sm text-kumo-subtle">
        {status === null ? 'Checking local ChatGPT connection…' : !status.available
          ? 'Available only with the local ChatGPT broker. Start the local app with pnpm run-local --chatgpt.'
          : status.connected ? `Connected to ChatGPT${status.email ? ` as ${status.email}` : ''}` : 'Not connected to ChatGPT'}
      </p>
      {status?.connected && status.sharingEnabled === false && <p className="text-sm text-kumo-subtle">ChatGPT subscription sharing is not enabled for this connection. Enable it in the sign-in flow before adding models.</p>}
      {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-kumo-subtle">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        {status?.available && <Button onClick={connect} disabled={busy || waiting}>
          {status.connected ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
        </Button>}
        <Button variant="secondary" disabled={busy} onClick={() => { void refresh(waiting) }}>Refresh connection</Button>
        {status?.connected && <Button variant="secondary" disabled={busy || waiting} onClick={disconnect}>Disconnect ChatGPT</Button>}
      </div>
      {waiting && <p className="text-sm text-kumo-subtle">Complete sign-in in the popup, then close it or refresh this connection.</p>}
      {status?.connected && models.length > 0 && <>
        <Select label="ChatGPT model" value={selected} onValueChange={value => setSelected(String(value))}
          renderValue={value => models.find(model => model.slug === value)?.displayName ?? String(value)}>
          {models.map(model => <Select.Option key={model.slug} value={model.slug}>{model.displayName}</Select.Option>)}
        </Select>
        <div className="space-y-2 text-sm text-kumo-subtle">
          <Checkbox label="Use as preferred chat model" checked={preferred} onCheckedChange={value => setPreferred(value === true)} />
          <Checkbox label="Use as quick model for chat titles and other fast tasks" checked={quick} onCheckedChange={value => setQuick(value === true)} />
        </div>
        <Button variant="primary" disabled={busy || waiting || !selected} onClick={addModel}>Add ChatGPT model</Button>
      </>}
      {status?.connected && status.sharingEnabled !== false && models.length === 0 && !error && <p className="text-sm text-kumo-subtle">No ChatGPT models are available. Refresh or reconnect to try again.</p>}
    </section>
  )
}
