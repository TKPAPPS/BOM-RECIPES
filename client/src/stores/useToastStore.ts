import { create } from 'zustand';
import { nanoid } from 'nanoid';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (title: string, opts?: { type?: ToastType; message?: string; duration?: number }) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (title, opts = {}) => {
    const { type = 'info', message, duration = 4200 } = opts;
    const id = nanoid();
    set((s) => ({ toasts: [...s.toasts, { id, type, title, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, duration);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
