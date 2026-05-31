import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToastStore } from '../../stores/useToastStore';
import type { ToastType } from '../../stores/useToastStore';

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
};

interface ToastItemProps {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

const ToastItem: React.FC<ToastItemProps> = ({ id, type, title, message }) => {
  const [visible, setVisible] = useState(false);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleDismiss = () => {
    setVisible(false);
    setTimeout(() => dismiss(id), 280);
  };

  return (
    <div
      className={`toast toast--${type} ${visible ? 'toast--visible' : ''}`}
      role="alert"
      aria-live="assertive"
    >
      <span className={`toast__icon toast__icon--${type}`}>{ICONS[type]}</span>
      <div className="toast__body">
        <span className="toast__title">{title}</span>
        {message && <span className="toast__message">{message}</span>}
      </div>
      <button className="toast__close" onClick={handleDismiss} aria-label="Dismiss notification">
        ✕
      </button>
    </div>
  );
};

export const ToastContainer: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);
  return createPortal(
    <div className="toast-container" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
    </div>,
    document.body
  );
};
