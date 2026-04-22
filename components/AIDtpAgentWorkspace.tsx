import React, { useState } from 'react';
import JSZip from 'jszip';
import { Upload, Image as ImageIcon, Wand2, FileText, Download, Play, Eye } from 'lucide-react';
import { analyzePdf, dtpAgentLayout, generateImage, vivliostyleBuild, extractInstruction } from '../services/api';

const C = {
  bg: '#f8fafc',
};

export const AIDtpAgentWorkspace: React.FC = () => {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 2 Data
  const [extractedText, setExtractedText] = useState<string>('');
  const [extractedImages, setExtractedImages] = useState<{ id: string; b64: string }[]>([]);
  const [instructionJson, setInstructionJson] = useState<string>('');
  const [remakePrompt, setRemakePrompt] = useState('');

  // Step 3 Data
  const [generatedHtml, setGeneratedHtml] = useState<string>('');
  const [generatedCss, setGeneratedCss] = useState<string>('');

  // Step 4 Data
  const [finalPdfB64, setFinalPdfB64] = useState<string>('');

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      const res = await analyzePdf(file, true);
      
      // Extract text from spans
      let text = '';
      const images: { id: string; b64: string }[] = [];
      
      res.pages.forEach(page => {
        page.spans.forEach(span => {
          text += span.text + '\n';
        });
        page.images.forEach(img => {
          images.push({ id: img.id, b64: img.data_b64 });
        });
      });

      setExtractedText(text);
      setExtractedImages(images);

      // Call extractInstruction to generate JSON from text
      let instructionJsonStr = '';
      try {
        const extracted = await extractInstruction({
          content_text: text,
          analyze_data: res // Pass full analyze result (Document AI, Vision, Yomiwake)
        });
        instructionJsonStr = JSON.stringify(extracted, null, 2);
      } catch (e) {
        console.warn('Instruction extraction failed, falling back to default:', e);
        const defaultInstruction = {
          project_metadata: {
            system_version: "TypoPro-Web v1.0",
            status: "In Proofing (初校調整中)"
          },
          instruction_manual: {
            header: {
              product_name: { label_jp: "品名", value: "名刺" },
            },
            layout_rules: {
              grid: "8pt",
              fonts: ["Noto Sans JP", "Noto Serif JP"]
            }
          },
          content: {
            company_name: "株式会社サンプル",
            department: "営業部",
            title: "部長",
            name: "山田 太郎",
            address: "東京都渋谷区...",
            tel: "03-0000-0000",
            email: "info@example.com"
          }
        };
        instructionJsonStr = JSON.stringify(defaultInstruction, null, 2);
      }
      setInstructionJson(instructionJsonStr);
      setStep(2);
    } catch (err: any) {
      setError(err.message || 'アップロードに失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const handleRemakeImage = async (imgId: string) => {
    if (!remakePrompt) return;
    setLoading(true);
    try {
      const res = await generateImage({
        prompt: remakePrompt,
      });
      if (res.images && res.images.length > 0) {
        setExtractedImages(prev => prev.map(img => img.id === imgId ? { ...img, b64: res.images[0].data_b64 } : img));
      }
    } catch (err: any) {
      setError(err.message || '画像生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const handleRunAgent = async () => {
    setLoading(true);
    setError(null);
    try {
      let parsedJson;
      try {
        parsedJson = JSON.parse(instructionJson);
      } catch (e) {
        throw new Error('JSONの形式が正しくありません。');
      }

      const res = await dtpAgentLayout({
        instruction_manual: parsedJson,
        content_text: extractedText,
      });
      setGeneratedHtml(res.html);
      setGeneratedCss(res.css);
      setStep(3);
    } catch (err: any) {
      setError(err.message || 'エージェントの実行に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const handleBuildPdf = async () => {
    setLoading(true);
    setError(null);
    try {
      const dirName = `agent_output_${Date.now()}`;
      const res = await vivliostyleBuild(
        [],
        [210, 297], // A4 fallback
        'DTP Agent Output',
        undefined,
        generatedHtml,
        generatedCss,
        dirName,
        extractedImages
      );
      setFinalPdfB64(res.pdf_b64);
      setStep(4);
    } catch (err: any) {
      setError(err.message || 'PDF生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadJson = () => {
    const blob = new Blob([instructionJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dtp_instruction.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadImage = (id: string, b64: string) => {
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${b64}`;
    link.download = `extracted_image_${id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadZip = async () => {
    const zip = new JSZip();
    zip.file("dtp_instruction.json", instructionJson);
    zip.file("extracted_content.txt", extractedText);
    
    extractedImages.forEach((img) => {
      zip.file(`extracted_image_${img.id}.png`, img.b64, { base64: true });
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dtp_workspace_assets.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col" style={{ background: C.bg }}>
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Wand2 className="text-indigo-500" />
          AI DTP エージェント
        </h1>
        <p className="text-gray-500 mt-2">
          インポート → 抽出 → 画像リメイク → DTPエージェント → プレビュー → PDF出力
        </p>

        {/* Stepper */}
        <div className="flex items-center gap-4 mt-6">
          {[
            { s: 1, label: 'インポート' },
            { s: 2, label: '抽出・調整' },
            { s: 3, label: 'エージェントプレビュー' },
            { s: 4, label: '最終出力' },
          ].map(item => (
            <div key={item.s} className={`flex items-center gap-2 ${step >= item.s ? 'text-indigo-600 font-bold' : 'text-gray-400'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs text-white ${step >= item.s ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                {item.s}
              </div>
              {item.label}
              {item.s < 4 && <span className="text-gray-300 ml-2">→</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-lg border border-red-200">
            {error}
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 1 && (
          <div className="max-w-2xl mx-auto mt-10">
            <div className="bg-white p-10 rounded-2xl shadow-sm border border-gray-200 text-center">
              <Upload size={48} className="mx-auto text-indigo-400 mb-4" />
              <h2 className="text-xl font-bold mb-4">PDFまたは画像をアップロード</h2>
              <input
                type="file"
                id="dtp-upload"
                className="hidden"
                accept=".pdf,image/*"
                onChange={handleFileUpload}
              />
              <button
                disabled={loading}
                onClick={() => document.getElementById('dtp-upload')?.click()}
                className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-bold shadow hover:bg-indigo-700 disabled:opacity-50"
              >
                {loading ? '処理中...' : 'ファイルを選択'}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Extract & Edit */}
        {step === 2 && (
          <div className="grid grid-cols-2 gap-6 h-full">
            <div className="flex flex-col gap-4">
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex-1 flex flex-col overflow-hidden">
                <div className="p-4 border-b border-gray-100 bg-gray-50 font-bold flex items-center gap-2">
                  <FileText size={18} /> 抽出テキスト
                </div>
                <textarea
                  className="flex-1 p-4 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={extractedText}
                  onChange={e => setExtractedText(e.target.value)}
                />
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 h-64 flex flex-col overflow-hidden">
                <div className="p-4 border-b border-gray-100 bg-gray-50 font-bold flex items-center gap-2">
                  <ImageIcon size={18} /> 抽出画像のリメイク
                </div>
                <div className="p-4 overflow-auto flex gap-4">
                  {extractedImages.length === 0 ? (
                    <p className="text-gray-500 text-sm">画像はありません</p>
                  ) : (
                    extractedImages.map(img => (
                      <div key={img.id} className="border border-gray-200 rounded p-2 min-w-[150px]">
                        <img src={`data:image/png;base64,${img.b64}`} alt="Extracted" className="w-full h-24 object-contain bg-gray-100 mb-2 rounded" />
                        <button
                          onClick={() => handleDownloadImage(img.id, img.b64)}
                          className="w-full bg-gray-100 text-gray-700 text-xs py-1 rounded font-bold hover:bg-gray-200 mb-2"
                        >
                          画像を保存
                        </button>
                        <input
                          type="text"
                          placeholder="画像指示 (Imagen)"
                          className="w-full text-xs p-1 border rounded mb-2"
                          onChange={e => setRemakePrompt(e.target.value)}
                        />
                        <button
                          onClick={() => handleRemakeImage(img.id)}
                          disabled={loading}
                          className="w-full bg-indigo-100 text-indigo-700 text-xs py-1 rounded font-bold hover:bg-indigo-200 disabled:opacity-50"
                        >
                          画像生成
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-gray-100 bg-gray-50 font-bold flex items-center justify-between">
                <span>指示書記述 (JSON)</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownloadZip}
                    className="px-4 py-1.5 bg-green-100 text-green-700 rounded font-bold text-sm shadow hover:bg-green-200 flex items-center gap-2"
                  >
                    <Download size={16} /> 一括ZIP保存
                  </button>
                  <button
                    onClick={handleDownloadJson}
                    className="px-4 py-1.5 bg-gray-100 text-gray-700 rounded font-bold text-sm shadow hover:bg-gray-200"
                  >
                    JSONを保存
                  </button>
                  <button
                    onClick={handleRunAgent}
                    disabled={loading}
                    className="px-4 py-1.5 bg-indigo-600 text-white rounded font-bold text-sm shadow flex items-center gap-2 hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {loading ? '処理中...' : <><Play size={16} /> エージェント実行</>}
                  </button>
                </div>
              </div>
              <textarea
                className="flex-1 p-4 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-gray-900 text-green-400"
                value={instructionJson}
                onChange={e => setInstructionJson(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Step 3: Agent Preview */}
        {step === 3 && (
          <div className="grid grid-cols-2 gap-6 h-full">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-gray-100 bg-gray-50 font-bold flex items-center justify-between">
                <span>生成されたHTML / CSS</span>
                <button
                  onClick={() => setStep(2)}
                  className="px-3 py-1 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200"
                >
                  戻る
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4 font-mono text-xs bg-gray-50 text-gray-800 flex flex-col gap-4">
                <div>
                  <div className="font-bold text-gray-500 mb-1">HTML</div>
                  <pre className="p-2 bg-white border border-gray-200 rounded overflow-auto">{generatedHtml}</pre>
                </div>
                <div>
                  <div className="font-bold text-gray-500 mb-1">CSS</div>
                  <pre className="p-2 bg-white border border-gray-200 rounded overflow-auto">{generatedCss}</pre>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-gray-100 bg-gray-50 font-bold flex items-center justify-between">
                <span className="flex items-center gap-2"><Eye size={18} /> レイアウトプレビュー</span>
                <button
                  onClick={handleBuildPdf}
                  disabled={loading}
                  className="px-4 py-1.5 bg-indigo-600 text-white rounded font-bold text-sm shadow flex items-center gap-2 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loading ? '作成中...' : <><Download size={16} /> PDF出力</>}
                </button>
              </div>
              <div className="flex-1 bg-gray-100 p-4 relative overflow-auto">
                {/* Simple iframe preview */}
                <iframe
                  title="DTP Preview"
                  className="w-full h-full bg-white shadow-md rounded"
                  srcDoc={`
                    <!DOCTYPE html>
                    <html>
                      <head>
                        <style>${generatedCss}</style>
                      </head>
                      <body>${generatedHtml}</body>
                    </html>
                  `}
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Final Output */}
        {step === 4 && (
          <div className="max-w-4xl mx-auto h-full flex flex-col">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 text-center mb-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">🎉 PDF出力完了</h2>
              <p className="text-gray-500 mb-6">Vivliostyleによる最終PDFが生成されました。</p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => setStep(3)}
                  className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg font-bold hover:bg-gray-200"
                >
                  編集に戻る
                </button>
                <button
                  onClick={() => {
                    if (finalPdfB64) {
                      const link = document.createElement('a');
                      link.href = `data:application/pdf;base64,${finalPdfB64}`;
                      link.download = 'dtp_agent_output.pdf';
                      link.click();
                    }
                  }}
                  className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-bold shadow hover:bg-indigo-700 flex items-center gap-2"
                >
                  <Download size={20} /> PDFをダウンロード
                </button>
              </div>
            </div>

            <div className="flex-1 bg-gray-100 rounded-xl overflow-hidden shadow-inner relative">
              {finalPdfB64 ? (
                <iframe
                  title="PDF Preview"
                  className="w-full h-full"
                  src={`data:application/pdf;base64,${finalPdfB64}`}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400">PDFを読み込めませんでした</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};