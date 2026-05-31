import React, { useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useModalStore } from '../../stores/useModalStore';
import { api } from '../../api';
import { BomTree } from './BomTree';

export const BomDrillDownModal: React.FC = () => {
  const { stack, pop, clear } = useModalStore();

  const activeItemId = stack[stack.length - 1] ?? null;

  const { data: bom, isLoading, isError } = useQuery({
    queryKey: ['bom', activeItemId],
    queryFn: () => api.getBom(activeItemId!),
    enabled: activeItemId !== null,
    staleTime: 60_000,
  });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') pop();
    },
    [pop]
  );

  useEffect(() => {
    if (activeItemId === null) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeItemId, handleKeyDown]);

  if (activeItemId === null) return null;

  return createPortal(
    <div
      className="bom-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="BOM Detail"
      style={{ zIndex: 1000 + stack.length * 10 }}
      onClick={(e) => e.target === e.currentTarget && pop()}
    >
      <div className="bom-modal">
        {stack.length > 1 && (
          <div className="bom-modal__depth">
            Depth: {stack.length} levels deep
          </div>
        )}

        <div className="bom-modal__header">
          <h3 className="bom-modal__title">
            {isLoading ? 'Loading…' : bom?.recipe_name ?? 'BOM Detail'}
          </h3>
          <div className="bom-modal__header-actions">
            {stack.length > 1 && (
              <button onClick={pop} className="btn btn--ghost btn--sm">
                ← Back
              </button>
            )}
            <button onClick={clear} aria-label="Close" className="bom-modal__close">
              ✕
            </button>
          </div>
        </div>

        <div className="bom-modal__body">
          {isLoading && <p className="bom-modal__status">Fetching BOM…</p>}
          {isError && (
            <p className="bom-modal__status bom-modal__status--error">
              Failed to load BOM.
            </p>
          )}
          {bom && <BomTree bom={bom} />}
        </div>
      </div>
    </div>,
    document.body
  );
};
