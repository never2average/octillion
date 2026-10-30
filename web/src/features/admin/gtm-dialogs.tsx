'use client';
// GTM: the small questions an action asks before it runs (a tag to add, an owner, why a deal was lost, "delete these
// N?"), as the admin's own dialogs with labelled buttons, never the browser's prompt or confirm. Controlled: the page
// keeps which question is open (or null) and gets the answer in onSubmit.
import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';

/** A question with one line of text to type (optional or required), and labelled Cancel / submit buttons. */
export function TextDialog({ open, title, description, label, placeholder, submitLabel, required, onSubmit, onClose }: {
  open: boolean; title: string; description?: ReactNode; label: string; placeholder?: string; submitLabel: string; required?: boolean;
  onSubmit: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => { if (open) setValue(''); }, [open]);
  const ok = !required || value.trim().length > 0;
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <form onSubmit={(e) => { e.preventDefault(); if (ok) { onSubmit(value.trim()); onClose(); } }} className='grid gap-4'>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <label className='grid gap-1.5 text-sm'>
            <span className='leading-none font-medium'>{label}</span>
            <Input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel type='button'>Cancel</AlertDialogCancel>
            <AlertDialogAction type='submit' disabled={!ok}>{submitLabel}</AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Are you sure?" opened from a menu item (ConfirmButton is for a button of its own). */
export function ConfirmDialog({ open, title, description, confirmLabel, destructive, onConfirm, onClose }: {
  open: boolean; title: string; description: ReactNode; confirmLabel: string; destructive?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={() => { onClose(); onConfirm(); }}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
