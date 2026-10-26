import { useState } from 'react';
import { Button, Icon, Input } from '../../arclight/index.js';
import { PathPickerDialog } from './path-picker.js';
import './path-picker.css';

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

/** A mono path text box with a Browse button that opens the folder picker. Works inside Field / FormRow. */
export function PathInput({ value, onChange, pickerTitle, selectFiles = false, browseLabel = 'Browse…', ...input }: PathInputProps) {
  const [open, setOpen] = useState(false);
  const label = input['aria-label'] ?? 'path';
  return (
    <span className="mt-path-input">
      <Input {...input} mono value={value} onChange={(e) => onChange(e.currentTarget.value)} spellCheck={false} autoComplete="off" />
      <Button variant="secondary" icon={<Icon name="folder" />} disabled={input.disabled ?? false} onClick={() => setOpen(true)} aria-label={`Browse for ${label}`}>
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
