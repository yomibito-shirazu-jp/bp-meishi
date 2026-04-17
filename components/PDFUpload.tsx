import React, { useState, useCallback } from 'react';
import { Upload, FileText, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

interface PDFUploadProps {
  onProcessingComplete?: (result: any) => void;
  onError?: (error: string) => void;
}

interface ProcessingResult {
  business_card: {
    card_info: Record<string, string>;
    confidence: number;
    blocks: any[];
    full_text: string;
  };
  documentai_result: any;
}

export const PDFUpload: React.FC<PDFUploadProps> = ({ onProcessingComplete, onError }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedFile, setProcessedFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const processPDF = useCallback(async (file: File) => {
    setIsProcessing(true);
    setProcessedFile(file);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/documentai-business-card', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Processing failed: ${errorText}`);
      }

      const result: ProcessingResult = await response.json();
      setResult(result);
      onProcessingComplete?.(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      onError?.(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [onError, onProcessingComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    const pdfFile = files.find((file: File) => file.type === 'application/pdf');
    
    if (pdfFile) {
      processPDF(pdfFile);
    } else {
      onError?.('Please upload a PDF file');
    }
  }, [onError, processPDF]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      processPDF(file);
    } else {
      onError?.('Please select a PDF file');
    }
  }, [onError, processPDF]);

  const resetUpload = () => {
    setProcessedFile(null);
    setResult(null);
    setIsProcessing(false);
  };

  return (
    <div className="w-full max-w-2xl mx-auto p-6">
      {/* Upload Area */}
      {!processedFile && (
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-300 hover:border-gray-400'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Upload Business Card PDF
          </h3>
          <p className="text-gray-600 mb-4">
            Drag and drop a PDF file here, or click to select
          </p>
          <input
            type="file"
            accept=".pdf"
            onChange={handleFileSelect}
            className="hidden"
            id="pdf-upload"
          />
          <label
            htmlFor="pdf-upload"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 cursor-pointer"
          >
            Select PDF File
          </label>
        </div>
      )}

      {/* Processing State */}
      {isProcessing && (
        <div className="text-center py-8">
          <Loader2 className="mx-auto h-12 w-12 text-blue-600 animate-spin mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Processing PDF with Document AI
          </h3>
          <p className="text-gray-600">
            Extracting business card information...
          </p>
        </div>
      )}

      {/* Results */}
      {result && !isProcessing && (
        <div className="space-y-6">
          {/* Success Header */}
          <div className="flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center">
              <CheckCircle className="h-5 w-5 text-green-600 mr-2" />
              <span className="text-green-800 font-medium">
                PDF processed successfully
              </span>
            </div>
            <button
              onClick={resetUpload}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Upload another file
            </button>
          </div>

          {/* Business Card Information */}
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
              <FileText className="h-5 w-5 mr-2" />
              Extracted Business Card Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(result.business_card.card_info).map(([key, value]) => (
                <div key={key} className="border-b border-gray-100 pb-2">
                  <dt className="text-sm font-medium text-gray-500 capitalize">
                    {key.replace('_', ' ')}
                  </dt>
                  <dd className="text-sm text-gray-900 mt-1">
                    {value}
                  </dd>
                </div>
              ))}
            </div>

            {/* Confidence Score */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-500">
                  Extraction Confidence
                </span>
                <span className="text-sm font-medium text-gray-900">
                  {(result.business_card.confidence * 100).toFixed(1)}%
                </span>
              </div>
              <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full"
                  style={{ width: `${result.business_card.confidence * 100}%` }}
                />
              </div>
            </div>

            {/* Full Text */}
            {result.business_card.full_text && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h4 className="text-sm font-medium text-gray-500 mb-2">
                  Full Extracted Text
                </h4>
                <div className="bg-gray-50 p-3 rounded text-sm text-gray-700 whitespace-pre-wrap">
                  {result.business_card.full_text}
                </div>
              </div>
            )}
          </div>

          {/* Raw Document AI Result (Debug) */}
          <details className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-700">
              Raw Document AI Result (Debug)
            </summary>
            <pre className="mt-2 text-xs text-gray-600 overflow-x-auto">
              {JSON.stringify(result.documentai_result, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* Error State */}
      {!result && !isProcessing && processedFile && (
        <div className="text-center py-8">
          <AlertCircle className="mx-auto h-12 w-12 text-red-600 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Processing Failed
          </h3>
          <p className="text-gray-600 mb-4">
            There was an error processing your PDF. Please try again.
          </p>
          <button
            onClick={resetUpload}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
};
