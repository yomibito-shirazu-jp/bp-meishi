import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectPageLayout, extractPagesFromPdf } from './detect';
import * as configModule from './config';

// Mock the global fetch
global.fetch = vi.fn();

describe('detect.ts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    
    // Mock getConfig to return valid dummy values
    vi.spyOn(configModule, 'getConfig').mockImplementation((key) => {
      if (key === 'VITE_TYPESETTING_URL') return 'https://mock.supabase.co';
      if (key === 'VITE_TYPESETTING_ANON_KEY') return 'mock_anon_key';
      if (key === 'VITE_GOOGLE_AI_KEY') return 'mock_ai_key';
      return '';
    });
  });

  it('extractPagesFromPdf should call /analyze and return mapped pages', async () => {
    const mockFile = new File(['dummy'], 'test.pdf', { type: 'application/pdf' });
    const mockResponseData = {
      pages: [
        { original_png_b64: 'base64data1', page_mm: [210, 297] },
        { original_png_b64: 'base64data2', page_mm: [210, 297] }
      ]
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponseData,
    });

    const result = await extractPagesFromPdf(mockFile, 'http://localhost:8000');
    
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:8000/analyze', expect.any(Object));
    expect(result).toHaveLength(2);
    expect(result[0].page_number).toBe(1);
    expect(result[0].png_b64).toBe('base64data1');
    expect(result[0].page_mm).toEqual([210, 297]);
  });

  it('extractPagesFromPdf should throw an error when response is not ok', async () => {
    const mockFile = new File(['dummy'], 'test.pdf', { type: 'application/pdf' });
    
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(extractPagesFromPdf(mockFile, 'http://localhost:8000')).rejects.toThrow('PDF分析エラー: 500');
  });

  it('detectPageLayout should return result from Edge Function when successful', async () => {
    const mockEdgeResult = {
      success: true,
      session_id: 'mock_session',
      detection: { components: [] },
      validation: { status: 'approved' }
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockEdgeResult,
    });

    const params = {
      image_base64: 'mock_base64',
      customer_name: 'test',
      project_name: 'test',
      page_number: 1,
    };

    const result = await detectPageLayout(params);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('https://mock.supabase.co/functions/v1/detect-layout', expect.any(Object));
    expect(result).toEqual(mockEdgeResult);
  });

  it('detectPageLayout should fallback to direct Gemini API when Edge Function fails', async () => {
    // 1st fetch: Edge Function fails
    // 2nd fetch: Gemini API succeeds
    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  page_geometry: { margins: { top_mm: 10, bottom_mm: 10, inside_mm: 10, outside_mm: 10 }, base_column_count: 1, base_writing_mode: 'horizontal-tb' },
                  design_tokens: { primary_color: '#000000', base_font_family: 'Mincho', base_font_size_q: 13, base_line_height_q: 20 },
                  components: [
                    { component_code: 'main_article', component_name: '本文', semantic_tag: 'article', writing_mode: 'horizontal-tb', font_size_q: 13, line_height_q: 20, has_border: false, has_background: false, column_count: 1, estimated_area_pct: 80 }
                  ]
                })
              }
            ]
          }
        }
      ]
    };

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockGeminiResponse,
      });

    // Mock resizeImageBase64 implicitly because it depends on Image object
    // Wait, Image object might not be defined in JSDOM, or it may not trigger onload
    // We can spy on global Image or just let the real one run if jsdom supports it.
    // To make it safe, we can mock the global Image
    const originalImage = global.Image;
    global.Image = class {
      onload!: () => void;
      width = 800;
      height = 600;
      set src(_val: string) {
        setTimeout(() => this.onload(), 0);
      }
    } as any;

    const params = {
      image_base64: 'mock_base64',
      customer_name: 'test',
      project_name: 'test',
      page_number: 1,
    };

    const result = await detectPageLayout(params);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as any).mock.calls[1][0]).toContain('generativelanguage.googleapis.com');
    expect(result.success).toBe(true);
    expect(result.detection.components_count).toBe(1);
    expect(result.detection.components[0].code).toBe('main_article');

    global.Image = originalImage;
  });
});
