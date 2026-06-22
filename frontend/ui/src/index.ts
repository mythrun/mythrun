// Layout primitives (MYT-82 Wave 1). Each impl is typed against its contract in
// @mythrun/client-core; the contract prop types are re-exported here so app code
// imports component + props from the single package root.
export { Stack } from './components/Stack/Stack.tsx'
export { Box } from './components/Box/Box.tsx'
export { Grid } from './components/Grid/Grid.tsx'
export { Divider } from './components/Divider/Divider.tsx'

// Typography primitives (MYT-82 Wave 1b).
export { Text } from './components/Text/Text.tsx'
export { Heading } from './components/Heading/Heading.tsx'
export { Link } from './components/Link/Link.tsx'
export { VisuallyHidden } from './components/VisuallyHidden/VisuallyHidden.tsx'

// Leaf primitives (MYT-82 Wave 1c) — composed by the controls (Button loading,
// IconButton).
export { Icon } from './components/Icon/Icon.tsx'
export { Spinner } from './components/Spinner/Spinner.tsx'

// Controls (MYT-82 Wave 2a) — Button + IconButton, composing the Icon + Spinner
// leaves above.
export { Button } from './components/Button/Button.tsx'
export { IconButton } from './components/IconButton/IconButton.tsx'

// Text inputs (MYT-82 Wave 2b) — native <input>/<textarea>, neutral onChange.
export { Input } from './components/Input/Input.tsx'
export { TextArea } from './components/TextArea/TextArea.tsx'

// Form controls (MYT-82 Wave 2c) — Select / Checkbox / Radio + RadioGroup /
// Switch. Each wraps an unstyled `radix-ui` primitive, styled with our tokens,
// behind the DOM-free contract (neutral onChange).
export { Select } from './components/Select/Select.tsx'
export { Checkbox } from './components/Checkbox/Checkbox.tsx'
export { RadioGroup, Radio } from './components/RadioGroup/RadioGroup.tsx'
export { Switch } from './components/Switch/Switch.tsx'

// Form fields (MYT-82 Wave 2d) — Label + FormField. FormField wraps a single
// control with its Label, helper/error regions, and required/invalid state,
// wired for a11y via the controls' neutral `describedBy` relationship prop.
export { Label } from './components/Label/Label.tsx'
export { FormField } from './components/FormField/FormField.tsx'

export type {
  StackProps,
  BoxProps,
  GridProps,
  DividerProps,
  SpaceToken,
  TextProps,
  TextRole,
  HeadingProps,
  HeadingLevel,
  HeadingRole,
  LinkProps,
  VisuallyHiddenProps,
  IconProps,
  IconName,
  IconSize,
  SpinnerProps,
  ButtonProps,
  ButtonVariant,
  ButtonSize,
  ButtonType,
  IconButtonProps,
  InputProps,
  InputSize,
  InputType,
  TextAreaProps,
  SelectProps,
  SelectOption,
  SelectSize,
  CheckboxProps,
  CheckedState,
  RadioProps,
  RadioGroupProps,
  SwitchProps,
  LabelProps,
  FormFieldProps,
} from '@mythrun/client-core/contract'
