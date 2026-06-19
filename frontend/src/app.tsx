import { Text } from '@mythrun/ui'

// Placeholder root — its only job is to prove the @mythrun/ui import resolves.
// The real app shell (routing) arrives in MYT-83; i18n'd copy arrives with the
// i18n runtime in MYT-80. No user-facing string literal until then.
export function App(): React.JSX.Element {
  return <Text>{null}</Text>
}
