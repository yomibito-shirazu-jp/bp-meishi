// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, RefreshCw, ZoomIn, ZoomOut, CheckCircle, Save, FileEdit, Trash2, BoxSelect, Cpu, Edit3, ArrowUp, ArrowDown } from 'lucide-react';
import { fetchFontList } from './fontHelper';

export interface MeishiEditorProps {
  [key: string]: any; // To be refined
}

const MeishiEditor: React.FC<MeishiEditorProps> = (props) => {
  const {
    selectedId, spans, allPages, handlePageSwitch, currentPageIdx, C, previewTab, setPreviewTab, rebuiltPng, editCount,
    zoomOut, zoomReset, zoomIn, zoom, showOverlay, setShowOverlay, pageMM, originalSpans, setSelectedId,
    fieldCategories, CATEGORY_COLORS, CATEGORY_LABELS, FONT_LABELS, updateSpan, jobInstruction, pageImages,
    layoutBlocks, barcodes, detectedLanguages, imageReplacements, analyzingImageId, setAnalyzingImageId,
    visionResults, setVisionResults, flash, visionAnalyze, replacingImageId, setReplacingImageId, imgFileRef,
    setImageReplacements, setRebuiltPng, previewContainerRef, draggingId, handleMouseMove, handleMouseUp,
    originalPng, previewImgRef, handleOverlayMouseDown, handleDeleteSpan, setSpans, analyzeVisionField
  } = props;

  const [availableFonts, setAvailableFonts] = useState<string[]>([]);

  useEffect(() => {
    fetchFontList().then(setAvailableFonts);
  }, []);

  const sel = selectedId ? spans.find((s: any) => s.id === selectedId) : null;
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: '#1a1a2e' }}>
      {/* Top toolbar */}
      <div className="px-4 py-2 border-b flex items-center justify-between shrink-0" style={{ background: '#16162a', borderColor: '#2a2a4a' }}>
        <div className="flex items-center gap-3">
          {/* Page selector */}
          {allPages.length > 1 && (
            <div className="flex items-center gap-1">
              {allPages.map((p, i) => (
                <button
                  key={i}
                  onClick={() => handlePageSwitch(i)}
                  className="px-3 py-1.5 rounded text-xs font-medium transition-all"
                  style={{
                    background: currentPageIdx === i ? C.accent : 'transparent',
                    color: currentPageIdx === i ? '#fff' : '#8888aa',
                  }}
                >
                  {p.page_label || `P${i + 1}`}
                </button>
              ))}
            </div>
          )}
          {/* Preview tabs */}
          <div className="flex items-center gap-1 px-1 py-0.5 rounded-lg" style={{ background: '#12122a' }}>
            {([
              { key: 'edit' as const, label: 'プレビュー' },
              { key: 'original' as const, label: 'オリジナル' },
              ...(rebuiltPng ? [{ key: 'rebuilt' as const, label: '再構築済' }] : []),
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setPreviewTab(tab.key)}
                className="px-3 py-1.5 rounded text-xs font-medium transition-all"
                style={{
                  background: previewTab === tab.key ? '#2a2a4a' : 'transparent',
                  color: previewTab === tab.key ? '#fff' : '#6b6b8a',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {editCount > 0 && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
              {editCount}件変更
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Zoom */}
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: '#12122a' }}>
            <button onClick={zoomOut} className="p-0.5 rounded hover:bg-white/5 transition-colors" style={{ color: '#8888aa' }}>
              <ZoomOut size={14} />
            </button>
            <button onClick={zoomReset} className="px-2 text-xs font-mono" style={{ color: '#aaaacc' }}>
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={zoomIn} className="p-0.5 rounded hover:bg-white/5 transition-colors" style={{ color: '#8888aa' }}>
              <ZoomIn size={14} />
            </button>
          </div>
          {previewTab === 'edit' && (
            <button
              onClick={() => setShowOverlay(!showOverlay)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
              style={{
                background: showOverlay ? 'rgba(16,185,129,0.15)' : '#12122a',
                color: showOverlay ? '#10b981' : '#6b6b8a',
              }}
            >
              {showOverlay ? <Eye size={13} /> : <EyeOff size={13} />}
              枠線
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
      {/* Left: Field list */}
      <div className="w-80 flex flex-col shrink-0 border-r" style={{ background: '#16162a', borderColor: '#2a2a4a' }}>
        <div className="px-3 py-2.5 border-b flex items-center justify-between" style={{ borderColor: '#2a2a4a' }}>
          <span className="text-xs font-medium" style={{ color: '#8888aa' }}>
            フィールド ({spans.length})
          </span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{ background: '#12122a', color: '#6b6b8a' }}>
            {pageMM[0]}x{pageMM[1]}mm
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {spans.map((s, i) => {
            const isActive = selectedId === s.id;
            const changed = originalSpans[i] && s.text !== originalSpans[i].text;
            return (
              <div
                key={s.id}
                onClick={() => setSelectedId(isActive ? null : s.id)}
                className="px-3 py-2 cursor-pointer transition-colors"
                style={{
                  background: isActive ? 'rgba(16,185,129,0.08)' : 'transparent',
                  borderLeft: isActive ? '3px solid #10b981' : '3px solid transparent',
                  borderBottom: '1px solid #1e1e3a',
                }}
              >
                <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                  {fieldCategories[s.id] && fieldCategories[s.id] !== 'other' && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{
                      background: `${CATEGORY_COLORS[fieldCategories[s.id]] || '#6b7280'}20`,
                      color: CATEGORY_COLORS[fieldCategories[s.id]] || '#6b7280',
                    }}>
                      {CATEGORY_LABELS[fieldCategories[s.id]] || fieldCategories[s.id]}
                    </span>
                  )}
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background: '#12122a', color: '#6b6b8a' }}>
                    {FONT_LABELS[s.font_class] || s.font_class} {s.size_pt}pt
                  </span>
                  {s.writing_direction === 'vertical' && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background: 'rgba(251,146,60,0.15)', color: '#fb923c' }}>
                      縦
                    </span>
                  )}
                  {changed && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full ml-auto" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                      変更済
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={s.text}
                  onChange={e => updateSpan(s.id, { text: e.target.value })}
                  onFocus={() => setSelectedId(s.id)}
                  onClick={e => e.stopPropagation()}
                  className="w-full px-2.5 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all"
                  style={{
                    background: '#12122a',
                    border: `1px solid ${isActive ? '#10b981' : changed ? '#10b981' : '#2a2a4a'}`,
                    color: changed ? '#10b981' : '#e0e0f0',
                  }}
                />
                {changed && originalSpans[i] && (
                  <div className="text-[10px] mt-1 flex items-center gap-1" style={{ color: '#5a5a7a' }}>
                    <span className="line-through">{originalSpans[i].text}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Property Panel — shown when a span is selected */}
        {sel && (
          <div className="border-t px-3 py-3 space-y-3 shrink-0" style={{ borderColor: '#2a2a4a', background: '#12122a' }}>
            <h4 className="text-[11px] font-medium" style={{ color: '#8888aa' }}>プロパティ</h4>
            <div>
              <label className="text-[10px] block mb-1" style={{ color: '#6b6b8a' }}>フォント</label>
              <select
                value={sel.font_class}
                onChange={e => updateSpan(sel.id, { font_class: e.target.value as any })}
                className="w-full px-2.5 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                style={{ background: '#1a1a2e', border: '1px solid #2a2a4a', color: '#e0e0f0' }}
              >
                <optgroup label="デフォルト">
                  <option value="gothic">ゴシック</option>
                  <option value="mincho">明朝</option>
                  <option value="light">ライト</option>
                  <option value="gothic_bold">ゴシック太</option>
                </optgroup>
                {availableFonts.length > 0 && (
                  <optgroup label="カスタム">
                    {availableFonts.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <div>
              <label className="text-[10px] block mb-1" style={{ color: '#6b6b8a' }}>サイズ (pt)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={sel.size_pt}
                  onChange={e => updateSpan(sel.id, { size_pt: parseFloat(e.target.value) || sel.size_pt })}
                  step={0.5} min={1} max={120}
                  className="w-20 px-2.5 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  style={{ background: '#1a1a2e', border: '1px solid #2a2a4a', color: '#e0e0f0' }}
                />
                <div className="flex gap-1 flex-wrap">
                  {[6, 8, 10, 12, 14, 18, 24].map(sz => (
                    <button
                      key={sz}
                      onClick={() => updateSpan(sel.id, { size_pt: sz })}
                      className="px-2 py-1 rounded text-[10px] font-mono transition-colors"
                      style={{
                        background: sel.size_pt === sz ? 'rgba(16,185,129,0.15)' : '#1a1a2e',
                        color: sel.size_pt === sz ? '#10b981' : '#6b6b8a',
                        border: `1px solid ${sel.size_pt === sz ? '#10b981' : '#2a2a4a'}`,
                      }}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 text-[10px] font-mono" style={{ color: '#5a5a7a' }}>
              <span>X:{sel.x_pct.toFixed(1)}%</span>
              <span>Y:{sel.y_pct.toFixed(1)}%</span>
              <span>W:{sel.w_pct.toFixed(1)}%</span>
              <span>H:{sel.h_pct.toFixed(1)}%</span>
            </div>
          </div>
        )}

        {/* Job Instruction Panel */}
        {jobInstruction && (
          <div className="border-t px-3 py-3 space-y-2 shrink-0" style={{ borderColor: '#2a2a4a', background: '#0f0f20' }}>
            <h4 className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: '#8888aa' }}>
              <FileText size={12} /> 組版指示 (自動抽出)
            </h4>
            <div className="space-y-1 text-[10px] font-mono" style={{ color: '#6b6b8a' }}>
              <div className="flex justify-between">
                <span>サイズ</span>
                <span style={{ color: '#e0e0f0' }}>
                  {jobInstruction.typesetting_format.finished_size.format || '不明'}{' '}
                  ({jobInstruction.typesetting_format.finished_size.width_mm}×{jobInstruction.typesetting_format.finished_size.height_mm}mm)
                </span>
              </div>
              <div className="flex justify-between">
                <span>方向</span>
                <span style={{ color: '#e0e0f0' }}>{jobInstruction.typesetting_format.text_direction}</span>
              </div>
              <div className="flex justify-between">
                <span>本文級数</span>
                <span style={{ color: '#e0e0f0' }}>
                  {jobInstruction.typesetting_format.font_size_q}Q ({jobInstruction.typesetting_format.font_size_pt}pt)
                </span>
              </div>
              {jobInstruction.typesetting_format.line_spacing.size_q && (
                <div className="flex justify-between">
                  <span>行送り</span>
                  <span style={{ color: '#e0e0f0' }}>
                    {jobInstruction.typesetting_format.line_spacing.size_q}Q ({jobInstruction.typesetting_format.line_spacing.size_pt}pt)
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span>主フォント</span>
                <span style={{ color: '#e0e0f0' }} className="truncate ml-2 max-w-[150px]" title={jobInstruction.character_attributes.fonts.kanji}>
                  {jobInstruction.character_attributes.fonts.kanji.split('+').pop()?.split('-')[0] || '不明'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── PDF構成サマリー ── */}
        <div className="border-t px-3 py-2.5 shrink-0" style={{ borderColor: '#2a2a4a', background: '#12122a' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: spans.length > 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', color: spans.length > 0 ? '#10b981' : '#ef4444' }}>
              テキスト {spans.length > 0 ? `${spans.length}件` : 'なし'}
            </span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: pageImages.length > 0 ? 'rgba(59,130,246,0.15)' : 'rgba(107,114,128,0.15)', color: pageImages.length > 0 ? '#3b82f6' : '#6b7280' }}>
              画像 {pageImages.length > 0 ? `${pageImages.length}件` : 'なし'}
            </span>
            {layoutBlocks.length > 0 && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(168,85,247,0.15)', color: '#a855f7' }}>
                ブロック {layoutBlocks.length}
              </span>
            )}
            {barcodes.length > 0 && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(236,72,153,0.15)', color: '#ec4899' }}>
                バーコード {barcodes.length}
              </span>
            )}
            {detectedLanguages.length > 0 && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(34,211,238,0.15)', color: '#22d3ee' }}>
                {detectedLanguages.map(l => l.code).join('/')}
              </span>
            )}
            {Object.keys(imageReplacements).length > 0 && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(251,146,60,0.15)', color: '#fb923c' }}>
                差替 {Object.keys(imageReplacements).length}件
              </span>
            )}
          </div>
        </div>

        {/* ── 画像パネル ── */}
        {pageImages.length > 0 && (
          <div className="border-t px-3 py-2.5 shrink-0" style={{ borderColor: '#2a2a4a', background: '#0f0f20' }}>
            <h4 className="text-[11px] font-medium mb-2 flex items-center gap-1.5" style={{ color: '#8888aa' }}>
              📷 画像 ({pageImages.length})
            </h4>
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {pageImages.map(img => {
                const replaced = imageReplacements[img.id];
                const vr = visionResults[img.id];
                const isAnalyzing = analyzingImageId === img.id;
                const displaySrc = replaced
                  ? `data:${replaced.mime_type};base64,${replaced.data_b64}`
                  : `data:${img.mime_type};base64,${img.data_b64}`;
                return (
                  <div key={img.id} className="rounded-lg overflow-hidden" style={{ border: replaced ? '2px solid #fb923c' : '1px solid #2a2a4a' }}>
                    <img
                      src={displaySrc}
                      alt={img.id}
                      className="w-full h-20 object-contain"
                      style={{ background: '#1a1a2e' }}
                    />
                    <div className="flex items-center justify-between px-2 py-1" style={{ background: '#16162a' }}>
                      <span className="text-[9px] font-mono" style={{ color: '#6b6b8a' }}>
                        {img.width}×{img.height}
                        {replaced && <span style={{ color: '#fb923c' }}> (差替済)</span>}
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={async () => {
                            if (isAnalyzing) return;
                            setAnalyzingImageId(img.id);
                            try {
                              const result = await visionAnalyze(img.data_b64);
                              setVisionResults(prev => ({ ...prev, [img.id]: result }));
                              flash(`Vision解析完了: ${result.labels.length}ラベル検出`, 'ok');
                            } catch (err: any) {
                              flash(`Vision解析エラー: ${err.message}`, 'error');
                            }
                            setAnalyzingImageId(null);
                          }}
                          disabled={isAnalyzing}
                          className="text-[10px] font-medium px-2 py-0.5 rounded transition-colors"
                          style={{ background: 'rgba(168,85,247,0.15)', color: '#a855f7', opacity: isAnalyzing ? 0.5 : 1 }}
                        >
                          {isAnalyzing ? '解析中...' : 'AI解析'}
                        </button>
                        <button
                          onClick={() => {
                            setReplacingImageId(img.id);
                            imgFileRef.current?.click();
                          }}
                          className="text-[10px] font-medium px-2 py-0.5 rounded transition-colors"
                          style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}
                        >
                          差替
                        </button>
                      </div>
                    </div>

                    {/* ── Vision解析結果 ── */}
                    {vr && (
                      <div className="px-2 py-1.5 space-y-1.5" style={{ background: '#0d0d1f', borderTop: '1px solid #1e1e3a' }}>
                        {/* ラベル */}
                        {vr.labels.length > 0 && (
                          <div>
                            <div className="text-[9px] font-medium mb-0.5" style={{ color: '#a855f7' }}>ラベル</div>
                            <div className="flex flex-wrap gap-1">
                              {vr.labels.slice(0, 6).map((l, i) => (
                                <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(168,85,247,0.1)', color: '#c084fc' }}>
                                  {l.description} ({Math.round(l.score * 100)}%)
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* ロゴ */}
                        {vr.logos.length > 0 && (
                          <div>
                            <div className="text-[9px] font-medium mb-0.5" style={{ color: '#f472b6' }}>ロゴ</div>
                            <div className="flex flex-wrap gap-1">
                              {vr.logos.map((l, i) => (
                                <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(236,72,153,0.1)', color: '#f472b6' }}>
                                  {l.description}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* テキスト */}
                        {vr.full_text && (
                          <div>
                            <div className="text-[9px] font-medium mb-0.5" style={{ color: '#22d3ee' }}>検出テキスト</div>
                            <div className="text-[8px] p-1 rounded max-h-12 overflow-y-auto" style={{ background: 'rgba(34,211,238,0.05)', color: '#67e8f9', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                              {vr.full_text.slice(0, 200)}
                            </div>
                          </div>
                        )}

                        {/* 主要色 */}
                        {vr.dominant_colors.length > 0 && (
                          <div>
                            <div className="text-[9px] font-medium mb-0.5" style={{ color: '#fbbf24' }}>主要色</div>
                            <div className="flex gap-1">
                              {vr.dominant_colors.slice(0, 5).map((c, i) => (
                                <div
                                  key={i}
                                  className="w-5 h-5 rounded-sm border border-white/10"
                                  style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
                                  title={`RGB(${c.r},${c.g},${c.b}) ${Math.round(c.pixel_fraction * 100)}%`}
                                />
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Web類似画像 → 差し替え */}
                        {vr.web?.visually_similar_images?.length > 0 && (
                          <div>
                            <div className="text-[9px] font-medium mb-0.5" style={{ color: '#10b981' }}>類似画像 (クリックで差替)</div>
                            <div className="flex gap-1 flex-wrap">
                              {vr.web.visually_similar_images.slice(0, 4).map((si, i) => (
                                <button
                                  key={i}
                                  onClick={async () => {
                                    try {
                                      flash('類似画像をダウンロード中...', 'info');
                                      const proxyRes = await fetch(si.url);
                                      if (!proxyRes.ok) throw new Error('ダウンロード失敗');
                                      const blob = await proxyRes.blob();
                                      const buf = await blob.arrayBuffer();
                                      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                                      setImageReplacements(prev => ({
                                        ...prev,
                                        [img.id]: {
                                          xref: img.xref,
                                          data_b64: b64,
                                          mime_type: blob.type || 'image/png',
                                        },
                                      }));
                                      setRebuiltPng(null);
                                      setPreviewTab('edit');
                                      flash('類似画像で差し替えました', 'ok');
                                    } catch (err: any) {
                                      flash(`取得エラー: ${err.message}`, 'error');
                                    }
                                  }}
                                  className="w-12 h-12 rounded overflow-hidden border border-white/10 hover:border-green-400 transition-colors flex-shrink-0"
                                  title={si.url}
                                >
                                  <img src={si.url} alt={`similar-${i}`} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Webエンティティ */}
                        {vr.web?.web_entities?.length > 0 && (
                          <div>
                            <div className="text-[9px] font-medium mb-0.5" style={{ color: '#60a5fa' }}>Web検出</div>
                            <div className="flex flex-wrap gap-1">
                              {vr.web.web_entities.slice(0, 5).map((e, i) => (
                                <span key={i} className="text-[8px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(96,165,250,0.1)', color: '#93c5fd' }}>
                                  {e.description}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Safe Search */}
                        {Object.keys(vr.safe_search).length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {Object.entries(vr.safe_search).map(([k, v]) => (
                              <span key={k} className="text-[7px] px-1 py-0.5 rounded" style={{
                                background: v === 'VERY_LIKELY' || v === 'LIKELY' ? 'rgba(239,68,68,0.15)' : 'rgba(107,114,128,0.1)',
                                color: v === 'VERY_LIKELY' || v === 'LIKELY' ? '#ef4444' : '#6b7280',
                              }}>
                                {k}: {v}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Hidden file input for image replacement */}
            <input
              ref={imgFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file || !replacingImageId) return;
                const targetImg = pageImages.find(img => img.id === replacingImageId);
                if (!targetImg) return;
                try {
                  const buf = await file.arrayBuffer();
                  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                  setImageReplacements(prev => ({
                    ...prev,
                    [replacingImageId]: {
                      xref: targetImg.xref,
                      data_b64: b64,
                      mime_type: file.type || 'image/png',
                    },
                  }));
                  setRebuiltPng(null);
                  setPreviewTab('edit');
                  flash('画像を差し替えました', 'ok');
                } catch (err: any) {
                  flash(`画像読み込みエラー: ${err.message}`, 'error');
                }
                setReplacingImageId(null);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </div>

      {/* Center: Preview */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div
          ref={previewContainerRef}
          className="flex-1 overflow-auto"
          style={{ background: '#1a1a2e' }}
          onMouseMove={draggingId ? handleMouseMove : undefined}
          onMouseUp={draggingId ? handleMouseUp : undefined}
          onMouseLeave={draggingId ? handleMouseUp : undefined}
        >
          <div className="min-h-full flex items-center justify-center p-8">
          {previewTab === 'rebuilt' && rebuiltPng ? (
            <img
              src={rebuiltPng}
              alt="再構築プレビュー"
              className="object-contain rounded shadow-2xl"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: draggingId ? 'none' : 'transform 0.2s' }}
            />
          ) : previewTab === 'edit' ? (
            originalPng ? (
              <div
                ref={previewImgRef}
                className="relative rounded shadow-2xl overflow-visible bg-white"
                style={{
                  aspectRatio: `${pageMM[0]} / ${pageMM[1]}`,
                  maxHeight: `${85 * zoom}vh`,
                  maxWidth: `${95 * zoom}%`,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'center center',
                  transition: draggingId ? 'none' : 'transform 0.2s',
                }}
                onClick={() => { if (!draggingId) setSelectedId(null); }}
              >
                <img src={originalPng} alt="プレビュー" className="w-full h-full object-contain" style={{ opacity: showOverlay ? 0.6 : 1 }} draggable={false} />
                {showOverlay && spans.map((s, i) => {
                  const isActive = selectedId === s.id;
                  const isDragging = draggingId === s.id;
                  const changed = originalSpans[i] && s.text !== originalSpans[i].text;
                  const posChanged = originalSpans[i] && (s.x_pct !== originalSpans[i].x_pct || s.y_pct !== originalSpans[i].y_pct);
                  const isModified = changed || posChanged;
                  const fontFamily = s.font_class === 'mincho'
                    ? "'Noto Serif JP', 'Hiragino Mincho ProN', serif"
                    : "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif";
                  const fontWeight = s.font_class === 'gothic_bold' ? 700
                    : s.font_class === 'light' ? 300 : 400;
                  return (
                    <div
                      key={s.id}
                      onMouseDown={e => handleOverlayMouseDown(e, s.id)}
                      onClick={e => { e.stopPropagation(); if (!draggingId) setSelectedId(isActive ? null : s.id); }}
                      title={`${s.text}\nドラッグで移動`}
                      style={{
                        position: 'absolute',
                        left: `${s.x_pct}%`,
                        top: `${s.y_pct}%`,
                        width: `${s.w_pct}%`,
                        height: `${s.h_pct}%`,
                        cursor: isDragging ? 'grabbing' : 'grab',
                        border: isActive
                          ? '2px solid #3b82f6'
                          : isModified
                            ? '2px dashed #10b981'
                            : '1px solid rgba(59, 130, 246, 0.4)',
                        background: isDragging
                          ? 'rgba(59, 130, 246, 0.4)'
                          : isActive
                            ? 'rgba(59, 130, 246, 0.25)'
                            : isModified
                              ? 'rgba(255, 255, 255, 0.95)'
                              : 'rgba(59, 130, 246, 0.1)',
                        borderRadius: '4px',
                        transition: isDragging ? 'none' : 'all 0.15s',
                        zIndex: isDragging ? 30 : isActive ? 20 : 10,
                        userSelect: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: s.writing_direction === 'vertical' ? 'center' : 'flex-start',
                        overflow: 'hidden',
                        fontFamily,
                        fontWeight,
                        fontSize: s.writing_direction === 'vertical' 
                          ? `clamp(6px, ${s.w_pct * 0.65}vw, 48px)`
                          : `clamp(6px, ${s.h_pct * 0.65}vh, 48px)`,
                        lineHeight: 1,
                        color: isModified ? '#1e293b' : 'transparent',
                        whiteSpace: s.writing_direction === 'vertical' ? 'normal' : 'nowrap',
                        writingMode: s.writing_direction === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
                        textOrientation: 'upright',
                        padding: 0,
                      }}
                    >
                      {(isModified || isActive) ? s.text : ''}
                    </div>
                  );
                })}
                {showOverlay && pageImages.map((img) => (
                  <div
                    key={img.id}
                    title={`画像 / ID: ${img.id}`}
                    style={{
                      position: 'absolute',
                      left: `${img.x_pct}%`,
                      top: `${img.y_pct}%`,
                      width: `${img.w_pct}%`,
                      height: `${img.h_pct}%`,
                      border: '2px dashed rgba(59, 130, 246, 0.6)',
                      background: 'rgba(59, 130, 246, 0.15)',
                      borderRadius: '4px',
                      zIndex: 15,
                      pointerEvents: 'none',
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'flex-end',
                      overflow: 'hidden'
                    }}
                  >
                    <div className="bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-bl-sm opacity-80 shadow-sm">
                      📷 画像
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm" style={{ color: '#6b6b8a' }}>プレビューなし</div>
            )
          ) : (
            originalPng ? (
              <img
                src={originalPng}
                alt="オリジナル"
                className="object-contain rounded shadow-2xl"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 0.2s' }}
              />
            ) : (
              <div className="text-sm" style={{ color: '#6b6b8a' }}>オリジナル画像なし</div>
            )
          )}
          </div>
        </div>
      </div>
    </div>
    </div>
  );
};

export default MeishiEditor;
