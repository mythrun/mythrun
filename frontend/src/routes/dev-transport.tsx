import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Stack,
  Heading,
  Text,
  Card,
  CardHeader,
  CardBody,
  Button,
  Input,
  FormField,
  Badge,
  Divider,
  type BadgeVariant,
} from '@mythrun/ui'
import {
  createWsSessionClient,
  createSseStatusClient,
  useConnectionState,
  useApiContext,
  type ConnectionState,
  type ConnectionStatus,
  type WsSessionClient,
  type SseStatusClient,
} from '@mythrun/client-core'

// The `/dev/transport` harness (MYT-85 T9) — a DEV-ONLY manual rig for the
// realtime transport, registered lazily (a separate chunk excluded from the prod
// bundle; see `router.tsx`). It is NOT a player-facing screen: it composes bare
// @mythrun/ui primitives over the SAME barrel clients the play/world-gen flows
// use, so a developer can drive the real wire by hand — connect a session
// socket, round-trip a message, force a drop to watch reconnect-replay, and open
// an SSE status stream — against the real backend. The protocol state machine
// (reconnect-replay, seq dedup, close-routing) is covered by the client unit
// tests + the staging smoke; this is the human-in-the-loop driver for them.

// Connection status → Badge intent. A purely presentational map (UI, not
// cognition): a glanceable color for each transport state.
const STATUS_VARIANT = {
  connecting: 'info',
  connected: 'success',
  reconnecting: 'warning',
  closed: 'neutral',
  failed: 'danger',
} as const satisfies Record<ConnectionStatus, BadgeVariant>

/** One captured inbound row (a WS frame or an SSE event), keyed for the log list. */
interface LogRow {
  readonly id: number
  readonly body: string
}

// Test-id prefixes, held as identifiers (not inline JSX string literals): the
// no-literal-string rail excludes the `data-testid` attribute but NOT a custom
// `testid` prop, so passing these by reference keeps the rail green.
const WS_ID = 'ws'
const SSE_ID = 'sse'
const WS_FRAMES_ID = 'ws-frames'
const SSE_EVENTS_ID = 'sse-events'

/** A live connection-state readout: a colored status chip + the retry-attempt count. */
function StatusReadout({
  state,
  testid,
}: {
  state: ConnectionState
  testid: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack direction="row" gap={3} align="center" wrap>
      <Text role="ui-label">{t('devTransport.ws.statusLabel')}</Text>
      <Badge variant={STATUS_VARIANT[state.status]} data-testid={`${testid}-status`}>
        {state.status}
      </Badge>
      <Text role="ui-label">{t('devTransport.ws.attemptLabel')}</Text>
      <Text role="data" data-testid={`${testid}-attempt`}>
        {state.attempt}
      </Text>
    </Stack>
  )
}

/** An append-only inbound-row log (JSON-rendered frames/events), or an empty note. */
function InboundLog({
  rows,
  label,
  emptyNote,
  testid,
}: {
  rows: readonly LogRow[]
  label: string
  emptyNote: string
  testid: string
}): React.JSX.Element {
  return (
    <Stack gap={1} data-testid={testid}>
      <Text role="ui-label">{label}</Text>
      {rows.length === 0 ? (
        <Text role="ui-caption" data-testid={`${testid}-empty`}>
          {emptyNote}
        </Text>
      ) : (
        rows.map((row) => (
          <Text key={row.id} role="data" truncate>
            {row.body}
          </Text>
        ))
      )}
    </Stack>
  )
}

/** The WebSocket-session panel: connect / send / simulate-drop / close + the frame log. */
function WsPanel({
  ws,
  state,
  frames,
}: {
  ws: WsSessionClient
  state: ConnectionState
  frames: readonly LogRow[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [sessionId, setSessionId] = useState('')
  const [message, setMessage] = useState('')

  return (
    <Card>
      <CardHeader>
        <Heading level={2} role="title">
          {t('devTransport.ws.title')}
        </Heading>
      </CardHeader>
      <CardBody>
        <Stack gap={4}>
          <StatusReadout state={state} testid={WS_ID} />

          <Stack direction="row" gap={2} align="end" wrap>
            <FormField label={t('devTransport.ws.sessionIdLabel')} requiredLabel={t('form.required')}>
              <Input value={sessionId} onChange={setSessionId} data-testid="ws-session-input" />
            </FormField>
            <Button
              onPress={() => {
                // eslint-disable-next-line mythrun/no-raw-db-access -- ws.connect() opens the WebSocket session; the rule pattern-matches the `.connect()` method name (a Postgres pool heuristic), a false-fire on the transport client.
                ws.connect(sessionId)
              }}
              data-testid="ws-connect"
            >
              {t('devTransport.ws.connect')}
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                ws.__simulateDrop()
              }}
              data-testid="ws-drop"
            >
              {t('devTransport.ws.simulateDrop')}
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                ws.close()
              }}
              data-testid="ws-close"
            >
              {t('devTransport.ws.close')}
            </Button>
          </Stack>

          <Stack direction="row" gap={2} align="end" wrap>
            <FormField label={t('devTransport.ws.messageLabel')} requiredLabel={t('form.required')}>
              <Input value={message} onChange={setMessage} data-testid="ws-message-input" />
            </FormField>
            <Button
              onPress={() => {
                ws.send({ type: 'player_message', text: message })
              }}
              data-testid="ws-send"
            >
              {t('devTransport.ws.send')}
            </Button>
          </Stack>

          <Divider />

          <InboundLog
            rows={frames}
            label={t('devTransport.ws.framesLabel')}
            emptyNote={t('devTransport.ws.noFrames')}
            testid={WS_FRAMES_ID}
          />
        </Stack>
      </CardBody>
    </Card>
  )
}

/** The SSE status-stream panel: open a path / close + the event log. */
function SsePanel({
  sse,
  state,
  events,
}: {
  sse: SseStatusClient
  state: ConnectionState
  events: readonly LogRow[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [ssePath, setSsePath] = useState('')

  return (
    <Card>
      <CardHeader>
        <Heading level={2} role="title">
          {t('devTransport.sse.title')}
        </Heading>
      </CardHeader>
      <CardBody>
        <Stack gap={4}>
          <StatusReadout state={state} testid={SSE_ID} />

          <Stack direction="row" gap={2} align="end" wrap>
            <FormField label={t('devTransport.sse.pathLabel')} requiredLabel={t('form.required')}>
              <Input value={ssePath} onChange={setSsePath} data-testid="sse-path-input" />
            </FormField>
            <Button
              onPress={() => {
                sse.open(ssePath)
              }}
              data-testid="sse-open"
            >
              {t('devTransport.sse.open')}
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                sse.close()
              }}
              data-testid="sse-close"
            >
              {t('devTransport.sse.close')}
            </Button>
          </Stack>

          <Divider />

          <InboundLog
            rows={events}
            label={t('devTransport.sse.eventsLabel')}
            emptyNote={t('devTransport.sse.noEvents')}
            testid={SSE_EVENTS_ID}
          />
        </Stack>
      </CardBody>
    </Card>
  )
}

export function DevTransportRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()

  // One client per instance (stable across re-renders); a fresh harness mount
  // mints a fresh pair. Creating a client opens NO socket — connect()/open() do.
  const ws = useMemo(() => createWsSessionClient(ctx), [ctx])
  const sse = useMemo(() => createSseStatusClient(ctx), [ctx])

  const wsState = useConnectionState(ws)
  const sseState = useConnectionState(sse)

  const [frames, setFrames] = useState<readonly LogRow[]>([])
  const [events, setEvents] = useState<readonly LogRow[]>([])
  const rowId = useRef(0)

  // Subscribe to inbound frames; tear the socket down on unmount.
  useEffect(() => {
    const off = ws.onFrame((frame) => {
      rowId.current += 1
      setFrames((prev) => [...prev, { id: rowId.current, body: JSON.stringify(frame) }])
    })
    return () => {
      off()
      ws.close()
    }
  }, [ws])

  // Subscribe to inbound SSE events; close the stream on unmount.
  useEffect(() => {
    const off = sse.onEvent((event) => {
      rowId.current += 1
      setEvents((prev) => [...prev, { id: rowId.current, body: JSON.stringify(event) }])
    })
    return () => {
      off()
      sse.close()
    }
  }, [sse])

  return (
    <Stack gap={5} data-testid="route-dev-transport">
      <Heading level={1}>{t('devTransport.title')}</Heading>
      <WsPanel ws={ws} state={wsState} frames={frames} />
      <SsePanel sse={sse} state={sseState} events={events} />
    </Stack>
  )
}
