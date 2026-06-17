import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useToastStore } from '../../stores/useToastStore';
import { getImageSrc, fmtQty } from '../RecipeBook/imageHelpers';
import type { TestDraftLine } from '../../types';

/**
 * Read-only view of a TEST recipe — mirrors the real recipe view
 * (RecipeAdminView) so it prints / saves-to-PDF identically, but reads
 * from the test sandbox.  Ingredients are grouped by preparation step;
 * ad-hoc (not-in-catalogue) ingredients are shown red.  Actions: Edit,
 * Print, Download PDF.
 */
export const TestRecipeView: React.FC = () => {
  const { itemId } = useParams<{ itemId: string }>();
  const id = itemId ? parseInt(itemId, 10) : NaN;
  const { t } = useLang();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  const [showSendBack, setShowSendBack] = useState(false);
  const [note, setNote] = useState('');

  const { data: detail, isLoading, isError, error } = useQuery({
    queryKey: ['test-recipe', id],
    queryFn: () => api.getTestRecipe(id),
    enabled: Number.isFinite(id),
    retry: false,
  });

  const approve = useMutation({
    mutationFn: () => api.promoteTestRecipe(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['test-recipes'] });
      qc.invalidateQueries({ queryKey: ['boms'] });
      toast(t.promoteDone, { type: 'success' });
      navigate('/pending-recipes');
    },
    onError: (e: Error) => toast(t.promoteFailed, { type: 'error', message: e.message }),
  });

  const sendBack = useMutation({
    mutationFn: () => api.sendBackTestRecipe(id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['test-recipes'] });
      toast(t.sendBackDone, { type: 'success' });
      navigate('/pending-recipes');
    },
    onError: (e: Error) => toast(t.sendBackFailed, { type: 'error', message: e.message }),
  });

  if (isLoading) return <div className="view-placeholder"><p>{t.loading}</p></div>;
  if (isError || !detail) {
    return (
      <div className="view-placeholder">
        <p>{(error as Error)?.message || t.failedToLoad}</p>
        <Link to="/test-kitchen" className="btn btn--ghost">{t.rbBackToList}</Link>
      </div>
    );
  }

  const d = detail.draft;
  const steps = Array.isArray(d.steps) ? d.steps : [];
  const lines = Array.isArray(d.lines) ? d.lines : [];

  const handlePrint = () => {
    const prev = document.title;
    document.title = (detail.name || 'recipe').replace(/[\\/:*?"<>|]/g, '-');
    window.print();
    setTimeout(() => { document.title = prev; }, 500);
  };

  const lineName = (l: TestDraftLine) => l.resolved_item?.name || l.name || '—';
  const lineRef  = (l: TestDraftLine) => l.resolved_item?.reference || l.reference || '';

  const renderTable = (rows: TestDraftLine[]) => (
    <div className="recipe-view__table-wrap">
      <table className="recipe-view__table">
        <thead>
          <tr>
            <th>{t.ingredient}</th>
            <th>{t.refCode}</th>
            <th className="recipe-view__num">{t.rbQuantityHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => {
            const img = l.resolved_item ? getImageSrc(l.resolved_item.image_url) : null;
            return (
              <tr key={i} className={l.is_red ? 'ingredient-table__row--adhoc' : undefined}>
                <td>
                  <div className="recipe-view__ing-cell">
                    {img ? (
                      <img className="recipe-view__ing-thumb" src={img} alt="" loading="lazy" />
                    ) : (
                      <span className="recipe-view__ing-thumb recipe-view__ing-thumb--placeholder" aria-hidden="true">
                        {lineName(l).trim().charAt(0).toUpperCase() || '·'}
                      </span>
                    )}
                    <div className="recipe-view__ing-text">
                      {l.resolved_item ? (
                        <Link
                          to={l.resolved_item.item_type === 'recipe'
                            ? `/recipes/view/${l.resolved_item.id}`
                            : `/ingredient/${l.resolved_item.id}`}
                          className="recipe-view__ing-name recipe-view__ing-name--link"
                          title={l.resolved_item.item_type === 'recipe' ? t.openBaseRecipe : t.openIngredient}
                        >
                          {lineName(l)}
                        </Link>
                      ) : (
                        <span className="recipe-view__ing-name" style={l.is_red ? { color: '#b91c1c' } : undefined}>
                          {lineName(l)}
                        </span>
                      )}
                      {l.is_red && (
                        <span className="recipe-view__sub-pill" style={{ color: '#b91c1c', borderColor: '#f3c0c0' }}>
                          {t.testMissingTag}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="recipe-view__ref">{lineRef(l)}</td>
                <td className="recipe-view__num">{`${fmtQty(l.quantity_kg)} kg`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="recipe-view">
      {/* ── Top bar (hidden in print) ───────────────────────── */}
      <div className="recipe-view__topbar recipe-view__no-print">
        <button type="button" className="recipe-view__back" onClick={() => navigate(-1)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          <span>{t.rbBackToList}</span>
        </button>

        <div className="recipe-view__topbar-actions">
          <button type="button" className="recipe-view__action-btn" onClick={handlePrint} title={t.rbViewPrintTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            <span>{t.rbViewPrint}</span>
          </button>

          <button type="button" className="recipe-view__action-btn recipe-view__action-btn--pdf" onClick={handlePrint} title={t.rbViewPrintTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <polyline points="9 15 12 12 15 15"/>
            </svg>
            <span>{t.rbViewPdf}</span>
          </button>

          <Link to={`/test-recipe/${detail.id}`} className="btn btn--ghost recipe-view__edit-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            <span>{t.edit}</span>
          </Link>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────────────── */}
      <header className="recipe-view__hero">
        <div className="recipe-view__hero-media">
          {getImageSrc(d.image_url ?? null) ? (
            <img src={getImageSrc(d.image_url ?? null)!} alt={detail.name} />
          ) : (
            <div className="recipe-view__hero-fallback" aria-hidden="true">
              {detail.name.trim().charAt(0).toUpperCase() || '◈'}
            </div>
          )}
        </div>
        <div className="recipe-view__hero-body">
          <div className="recipe-view__type-tag">
            {detail.recipe_type === 'base' ? t.baseRecipeOption : t.finalProductOption}
            <span className="recipe-builder__test-badge" style={{ marginInlineStart: 8 }}>{t.testBadge}</span>
          </div>
          <h1 className="recipe-view__title">{d.full_name || detail.name}</h1>
          {detail.reference_code && <p className="recipe-view__ref">{detail.reference_code}</p>}
          {d.description && <p className="recipe-view__desc">{d.description}</p>}
          {(d.is_spicy || (d.allergens && d.allergens.length > 0)) && (
            <div className="recipe-view__chips">
              {d.is_spicy && <span className="recipe-view__chip recipe-view__chip--spicy">🌶 {t.rbSpicyTag}</span>}
              {d.allergens && d.allergens.length > 0 && (
                <span className="recipe-view__chip recipe-view__chip--allergen">
                  <strong>{t.rbAllergenLabel}:</strong> {d.allergens.join(' · ')}
                </span>
              )}
            </div>
          )}
          {detail.red_count > 0 && (
            <p className="recipe-view__desc" style={{ color: '#b91c1c', fontWeight: 600 }}>
              {t.testRedTooltip}
            </p>
          )}
        </div>
      </header>

      {/* ── Manager's feedback (when sent back for re-editing) ── */}
      {detail.review_note && (
        <div className="tr-review-note">
          <strong>{t.sendBackNoteLabel}</strong> {detail.review_note}
        </div>
      )}

      {/* ── Quick facts ─────────────────────────────────────── */}
      <section className="recipe-view__facts">
        <div className="recipe-view__fact">
          <div className="recipe-view__fact-label">{t.yieldKg}</div>
          <div className="recipe-view__fact-value">{fmtQty(d.yieldKg)} kg</div>
        </div>
        <div className="recipe-view__fact">
          <div className="recipe-view__fact-label">{t.linesHeader}</div>
          <div className="recipe-view__fact-value">{lines.length}</div>
        </div>
      </section>

      {/* ── Ingredients (flat list) ─────────────────────────── */}
      <section className="recipe-view__section">
        <h2 className="recipe-view__section-title">{t.rbIngredientsHeader}</h2>
        {renderTable(lines)}
      </section>

      {/* ── Preparation steps (optional instructions) ───────── */}
      {steps.length > 0 && (
        <section className="recipe-view__section">
          <h2 className="recipe-view__section-title">{t.prepStepsSection}</h2>
          {steps.map((step, idx) => (
            <div className="rb-detail__step" key={step.step_number}>
              <h3 className="rb-detail__step-title">
                <span className="rb-detail__step-num">{t.stepLabel} {idx + 1}</span>
                {step.name && <span className="rb-detail__step-name">{step.name}</span>}
              </h3>
              {step.description && <p className="rb-detail__step-process">{step.description}</p>}
            </div>
          ))}
        </section>
      )}

      {/* ── Manager review actions (pending recipes only) ─────── */}
      {isManager && detail.status === 'pending' && (
        <section className="recipe-view__section tr-review recipe-view__no-print">
          <div className="tr-review__actions">
            <button
              type="button"
              className="btn btn--primary tr-review__btn"
              disabled={detail.red_count > 0 || approve.isPending}
              title={detail.red_count > 0 ? t.promoteBlockedRed : t.approveRecipe}
              onClick={() => {
                if (window.confirm(t.approveConfirm.replace('{name}', detail.name))) approve.mutate();
              }}
            >
              {t.approveRecipe}
            </button>
            <button
              type="button"
              className="btn btn--ghost tr-review__btn"
              onClick={() => setShowSendBack((v) => !v)}
            >
              {t.sendBackBtn}
            </button>
          </div>

          {showSendBack && (
            <div className="tr-review__sendback">
              <label className="tr-review__label">{t.sendBackNoteLabel}</label>
              <textarea
                className="tr-review__note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t.sendBackNotePlaceholder}
              />
              <div className="tr-review__sendback-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={sendBack.isPending}
                  onClick={() => sendBack.mutate()}
                >
                  {t.sendBackConfirm}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => { setShowSendBack(false); setNote(''); }}
                >
                  {t.productsCancel}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
