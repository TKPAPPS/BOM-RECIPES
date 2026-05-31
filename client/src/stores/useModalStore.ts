import { create } from 'zustand';

interface ModalState {
  stack: number[];
  push: (itemId: number) => void;
  pop: () => void;
  clear: () => void;
}

export const useModalStore = create<ModalState>((set) => ({
  stack: [],
  push: (itemId) => set((s) => ({ stack: [...s.stack, itemId] })),
  pop: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  clear: () => set({ stack: [] }),
}));
