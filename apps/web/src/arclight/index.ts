// Arclight design system — React components over the kit's `.al-*` classes.
// Styles are NOT imported here (no side effects); at the app entry add:
//   import './arclight/fonts.js';
//   import './arclight/tokens.css';
// See ./README.md for the kit → component map and page recipes.

export * from './tokens.js';
export { cx } from './cx.js';

// Scene + shell
export { Backdrop, generateBackdrop, type BackdropProps, type BackdropGeometry, type BackdropOptions, type Segment } from './Backdrop.js';
export * from './Chrome/index.js';
export { mountBackdrop, backdropGeometry, type BackdropMotion, type BackdropMotionOptions, type MotionGeometry } from './arclight-motion.js';
export { applyTheme, restoreTheme, getActiveTheme, useActiveTheme, BUILTIN_THEME, type ActiveTheme, type ThemeBackdropKind } from './theme-store.js';
export { setReduceMotion, getReduceMotion, useReduceMotionSetting, REDUCE_MOTION_SETTINGS, type ReduceMotionSetting } from './motion-preference.js';

// Hooks
export { useFocusTrap, focusableIn, type FocusTrapOptions } from './hooks/use-focus-trap.js';
export { useHotkey, isTypingTarget } from './hooks/use-hotkey.js';
export { useMediaQuery, useReducedMotion, useOsReducedMotion, prefersReducedMotion, REDUCED_MOTION_QUERY } from './hooks/use-media-query.js';
export { useVirtualRows, computeVirtualRange, type VirtualRange, type VirtualRowsOptions } from './hooks/use-virtual-rows.js';

// Surfaces
export { Pane, FloatBar, FloatBarDivider, type PaneProps, type FloatBarProps, type Chamfer } from './components/Pane.js';
export { Modal, Drawer, modalWidth, type ModalProps, type ModalSize, type ModalWidth, type DrawerProps } from './components/Modal.js';
export { Tooltip, Popover, Menu, RejectionList, type TooltipProps, type PopoverProps, type MenuItem } from './components/Tooltip.js';
export { Toast, ToastStack, ToastViewport, toToastTone, visibleToasts, type ToastData, type ToastTone, type ToastProps, type ToastStackProps, type ToastStoreLike } from './components/Toast.js';

// Actions + inputs
export { Button, LinkButton, ButtonGroup, buttonClass, type ButtonProps, type LinkButtonProps, type ButtonVariant, type ButtonSize } from './components/Button.js';
export { Input, Textarea, Field, FormRow, FormSection, type InputProps, type TextareaProps, type FieldProps, type FormRowProps } from './components/Input.js';
export { Select, SelectMenu, type SelectOption, type SelectProps, type SelectMenuProps } from './components/Select.js';
export {
  Segmented,
  Checkbox,
  Radio,
  RadioGroup,
  Toggle,
  SwitchButton,
  Slider,
  type SegmentedOption,
  type SegmentedProps,
  type CheckboxProps,
  type RadioProps,
  type RadioGroupProps,
  type ToggleProps,
  type SwitchButtonProps,
  type SliderProps,
} from './components/Controls.js';
export { DatePicker, monthGrid, toIsoDate, parseIsoDate, type DatePickerProps } from './components/DatePicker.js';
export { PathPickerField, type PathPickerFieldProps, type PathEntry, type PathCrumb } from './components/PathPickerField.js';

// Status + data
export { Chip, StatusChip, type ChipProps, type ChipTone, type StatusChipProps } from './components/Chip.js';
export { Tag, QualityTag, ScoreTag, ProtocolBadge, CountBadge, formatScore, type TagProps, type ScoreTagProps, type Protocol } from './components/Tag.js';
export { Meter, Trail, Ring, LiveDot, meterIsLive, type MeterProps, type TrailProps, type TrailState, type RingProps } from './components/Progress.js';
export { Table, sortRows, nextSort, type Column, type SortState, type SortDirection, type SortValue, type RowKey, type TableProps } from './components/Table.js';
export { KeyValue, type KeyValueItem, type KeyValueProps } from './components/KeyValue.js';
export { SectionLabel, SectionHead, Index, type SectionLabelProps } from './components/SectionLabel.js';
export { Timeline, type TimelineItem } from './components/Timeline.js';

// Navigation + structure
export {
  Paginator,
  FilterBar,
  Tabs,
  Accordion,
  AccordionItem,
  Stepper,
  stepState,
  type PaginatorProps,
  type FilterBarProps,
  type TabItem,
  type TabsProps,
  type AccordionItemProps,
  type StepperProps,
  type StepperStep,
  type StepState,
} from './components/Navigation.js';
export { EmptyState, Skeleton, ErrorBlock, Banner, type EmptyStateProps, type SkeletonProps, type ErrorBlockProps, type BannerProps } from './components/States.js';

// Imagery + motion
export { Poster, BackdropFrame, PosterCard, type PosterProps, type BackdropFrameProps, type PosterCardProps } from './components/Media.js';
export { Derezz, ScanFilter, type DerezzProps } from './components/Derezz.js';
export { Icon, Mark, ICON_NAMES, type IconName, type IconProps } from './components/Icon.js';

// Overlays with data via props
export { KeyboardSheet, KeyCombo, DEFAULT_SHORTCUTS, type Shortcut, type ShortcutGroup, type KeyboardSheetProps } from './components/KeyboardSheet.js';
export { CommandPalette, GlobalSearchOverlay, type ResultItem, type ResultGroup, type CommandPaletteProps, type GlobalSearchOverlayProps } from './components/CommandPalette.js';
