import { useState } from 'react';
import { Button } from '../button.js';
import { Input } from '../form.js';
import { PathPickerDialog } from './path-picker.js';

export interface PathInputProps {
  value: string;
  onChange: (path: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /** Title of the browse dialog. */
  pickerTitle?: string;
  /** Let the browse dialog pick files as well as folders. */
  selectFiles?: boolean;
  /** Label of the browse button. */
  browseLabel?: string;
}

/** A path text box with a Browse button that opens the folder picker. Works inside FormField. */
export function PathInput({ value, onChange, pickerTitle, selectFiles = false, browseLabel = 'Browse…', ...input }: PathInputProps) {
  const [open, setOpen] = useState(false);
  const label = input['aria-label'] ?? 'path';
  return (
    <span className="path-input">
      <Input {...input} value={value} onChange={(e) => onChange(e.currentTarget.value)} spellCheck={false} />
      <Button disabled={input.disabled ?? false} onClick={() => setOpen(true)} aria-label={`Browse for ${label}`}>
        {browseLabel}
      </Button>
      <PathPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        initialPath={value}
        selectFiles={selectFiles}
        {...(pickerTitle ? { title: pickerTitle } : {})}
        onSelect={(p) => {
          onChange(p);
          setOpen(false);
        }}
      />
    </span>
  );
}
