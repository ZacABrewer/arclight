import type { ReactElement } from 'react';

// The field-definition vocabulary the schema form renders. It is a superset of the shapes the
// api serves for /downloadclient/schema (DownloadClientField), /customformat/schema
// (SpecFieldDefinition) and /notification/schema, so each can be passed straight in.

export type FieldType = 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'multiSelect' | 'regex' | 'textarea';

export interface FieldOption {
  value: string | number;
  label: string;
}

export interface FieldDefinition {
  /** Dotted path into the values object, e.g. `settings.host`. */
  name: string;
  label: string;
  type: FieldType;
  helpText?: string | undefined;
  required?: boolean | undefined;
  /** Hidden until "Show advanced" is on (unless it has an error). */
  advanced?: boolean | undefined;
  default?: unknown;
  options?: readonly FieldOption[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
  /** Shown after number inputs, e.g. "GB". */
  unit?: string | undefined;
  /** Stored value = shown value x scale (e.g. stored ms, shown minutes: 60000). */
  scale?: number | undefined;
  placeholder?: string | undefined;
}

export type FormValues = Record<string, unknown>;
export type FieldErrors = Record<string, string>;

export interface FieldRendererProps {
  field: FieldDefinition;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string | undefined;
}

/** Custom renderers keyed by field name (e.g. `tags`, `settings.categories`). */
export type FieldRenderers = Record<string, (props: FieldRendererProps) => ReactElement>;
