import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, triggerBlobDownload } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import type { RecipeImportReport, RecipeType, RecipeImportRowStatus } from '../../types';

/**
 * Modal dialog for uploading a filled .xlsx and creating / updating
 * recipes in bulk.  Shows a per-row report once the server responds.
 *
 * Open / close is owned by the parent (BomHistory) so list and modal
 * share filter context without prop-drilling a global store.
 */
interface Props {
  open:        boolean;
  onClose:     () => void;
  /** The current page's recipe type — used as the import default
   *  when the file's "Recipe Type" column is blank. */
  defaultType: RecipeType;
}

const STATUS_LABELS: Record<RecipeImportRowStatus, { key: string; tone: string }> = {
  created: { key: 'rioReportCreated', tone: 'rio-report__pill--created' },
  updated: { key: 'rioReportUpdated', tone: 'rio-report__pill--updated' },
  skipped: { key: 'rioReportSkipped', tone: 'rio-report__pill--skipped' },
  failed:  { key: 'rioReportFailed',  tone: 'rio-report__pill--failed'  },
};

export const RecipeImportModal: React.FC<Props> = ({ open, onClose, defaultType }) => {
  const { t }   = useLang();
  const qc      = useQueryClient();
  const toast   = useToastStore((s) => s.push);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [file,        setFile]        = useState<File | null>(null);
  const [dragging,    setDragging]    = useState(false);
  const [onDuplicate, setOnDuplicate] = useState<'update' | 'skip'>('update');
  const [report,      setReport]      = useState<RecipeImportReport | null>(null);

  // Reset modal state every time it opens so a previous result does
  // not bleed into a fresh import.
  useEffect(() => {
    if (open) {
      setFile(null);
      setDragging(false);
      setOnDuplicate('update');
      setReport(null);
    }
  }, [open]);

  // Esc key closes when no upload is in flight
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { mutate: runImport, isPending } = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('No file selected');
      return api.importRecipes(file, { onDuplicate, defaultType });
    },
    onSuccess: (data) => {
      setReport(data);
      qc.invalidateQueries({ queryKey: ['boms'] });
      const { created, updated, skipped, failed } = data;
      const tone =
        failed > 0 && created + updated === 0 ? 'error' :
        failed > 0                            ? 'warning' :
        'success';
      toast(
        t.rioReportTitle,
        {
          type: tone as 'success' | 'warning' | 'error',
          message: `${t.rioReportCreated}: ${created}  ·  ${t.rioReportUpdated}: ${updated}  ·  ${t.rioReportSkipped}: ${skipped}  ·  ${t.rioReportFailed}: ${failed}`,
        }
      );
    },
    onError: (err: Error) => {
      toast(t.rioImportFailedTitle, { type: 'error', message: err.message });
    },
  });

  const downloadTemplate = useCallback(async () => {
    try {
      const blob = await api.downloadRecipeTemplate();
      triggerBlobDownload(blob, 'recipe-import-template.xlsx');
    } catch (err) {
      toast(t.rioTemplateFailed, { type: 'error', message: (err as Error).message });
    }
  }, [t, toast]);

  const onSelectFile = (f: File | null) => {
    if (!f) return setFile(null);
    if (!/\.xlsx?$/i.test(f.name)) {
      toast(t.rioImportFailedTitle, { type: 'warning', message: 'Only .xlsx files are accepted.' });
      return;
    }
    setFile(f);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="rio-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t.rioImportTitle}
      onClick={(e) => e.target === e.currentTarget && !isPending && onClose()}
    >
      <div className="rio-modal">
        <header className="rio-modal__header">
          <div>
            <h3 className="rio-modal__title">{t.rioImportTitle}</h3>
            <p  className="rio-modal__subtitle">{t.rioImportSubtitle}</p>
          </div>
          <button
            className="rio-modal__close"
            onClick={onClose}
            disabled={isPending}
            aria-label={t.rioClose}
          >
            ✕
          </button>
        </header>

        {!report && (
          <>
            <div className="rio-modal__body">
              {/* ── Drop zone ─────────────────────────────────── */}
              <label
                className={`rio-dropzone${dragging ? ' rio-dropzone--dragging' : ''}${file ? ' rio-dropzone--has-file' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  onSelectFile(e.dataTransfer.files?.[0] ?? null);
                }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="rio-dropzone__input"
                  onChange={(e) => onSelectFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <div className="rio-dropzone__file">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="9" y1="13" x2="15" y2="13"/>
                      <line x1="9" y1="17" x2="13" y2="17"/>
                    </svg>
                    <div className="rio-dropzone__file-meta">
                      <strong>{file.name}</strong>
                      <span>{(file.size / 1024).toFixed(1)} KB · {t.rioFileSelected}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={(e) => {
                        e.preventDefault();
                        setFile(null);
                        if (inputRef.current) inputRef.current.value = '';
                      }}
                    >
                      {t.rioFileRemove}
                    </button>
                  </div>
                ) : (
                  <div className="rio-dropzone__empty">
                    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17 8 12 3 7 8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <strong>{t.rioDropFileHere}</strong>
                    <span>{t.rioOrBrowse}</span>
                  </div>
                )}
              </label>

              {/* ── Duplicate handling toggle ─────────────────── */}
              <fieldset className="rio-field">
                <legend className="rio-field__legend">{t.rioOnDuplicateLabel}</legend>
                <label className="rio-radio">
                  <input
                    type="radio"
                    name="rio-on-dup"
                    checked={onDuplicate === 'update'}
                    onChange={() => setOnDuplicate('update')}
                  />
                  <span>{t.rioOnDuplicateUpdate}</span>
                </label>
                <label className="rio-radio">
                  <input
                    type="radio"
                    name="rio-on-dup"
                    checked={onDuplicate === 'skip'}
                    onChange={() => setOnDuplicate('skip')}
                  />
                  <span>{t.rioOnDuplicateSkip}</span>
                </label>
              </fieldset>

              <button
                type="button"
                className="rio-template-link"
                onClick={downloadTemplate}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {t.rioDownloadTemplateLink}
              </button>
            </div>

            <footer className="rio-modal__footer">
              <button
                className="btn btn--ghost"
                onClick={onClose}
                disabled={isPending}
              >
                {t.rioCancel}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => runImport()}
                disabled={!file || isPending}
              >
                {isPending
                  ? <><span className="btn-spinner" aria-hidden="true" /> {t.rioImporting}</>
                  : t.rioStartImport}
              </button>
            </footer>
          </>
        )}

        {report && <ImportReport report={report} onClose={onClose} />}
      </div>
    </div>,
    document.body
  );
};

const ImportReport: React.FC<{ report: RecipeImportReport; onClose: () => void }> = ({ report, onClose }) => {
  const { t } = useLang();
  return (
    <div className="rio-report">
      <div className="rio-report__summary">
        <div className="rio-report__stat">
          <span className="rio-report__stat-num">{report.total}</span>
          <span className="rio-report__stat-label">{t.rioReportTotal}</span>
        </div>
        <div className="rio-report__stat rio-report__stat--created">
          <span className="rio-report__stat-num">{report.created}</span>
          <span className="rio-report__stat-label">{t.rioReportCreated}</span>
        </div>
        <div className="rio-report__stat rio-report__stat--updated">
          <span className="rio-report__stat-num">{report.updated}</span>
          <span className="rio-report__stat-label">{t.rioReportUpdated}</span>
        </div>
        <div className="rio-report__stat rio-report__stat--skipped">
          <span className="rio-report__stat-num">{report.skipped}</span>
          <span className="rio-report__stat-label">{t.rioReportSkipped}</span>
        </div>
        <div className="rio-report__stat rio-report__stat--failed">
          <span className="rio-report__stat-num">{report.failed}</span>
          <span className="rio-report__stat-label">{t.rioReportFailed}</span>
        </div>
      </div>

      {report.details.length === 0 ? (
        <p className="rio-report__empty">{t.rioReportEmpty}</p>
      ) : (
        <div className="rio-report__table-wrap">
          <table className="rio-report__table">
            <thead>
              <tr>
                <th>{t.rioReportRow}</th>
                <th>{t.rioReportName}</th>
                <th>{t.rioReportStatus}</th>
                <th>{t.rioReportMessage}</th>
              </tr>
            </thead>
            <tbody>
              {report.details.map((d, i) => {
                const label = STATUS_LABELS[d.status];
                return (
                  <tr key={i}>
                    <td className="rio-report__row-num">{d.row}</td>
                    <td className="rio-report__name">{d.name}</td>
                    <td>
                      <span className={`rio-report__pill ${label.tone}`}>
                        {t[label.key as keyof typeof t]}
                      </span>
                    </td>
                    <td className="rio-report__msg">{d.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rio-modal__footer">
        <button className="btn btn--primary" onClick={onClose}>{t.rioClose}</button>
      </div>
    </div>
  );
};
