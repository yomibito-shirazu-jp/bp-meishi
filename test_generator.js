import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { getDefaultFont } from '@pdfme/common';

async function testPdfGenerate() {
  console.log("Starting PDF modification test...");
  
  // 1. We create a dummy base PDF first to simulate uploaded manuscript.
  // Actually, wait, let's create a blank base64 PDF just like pdfme usually does, or just use BLANK_PDF.
  const BLANK_PDF = "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nDPQM1Qo5ypUMFAwALJMLU31jBQsTAz1LBSK0rPzSlPjDZXKM1NSc1OVPDKTUvPSjS1VUgtKUvPSXTIzU4uTjWp1DE2M9EwNdAwBf28SDwplbmRzdHJlYW0KZW5kb2JqCgozIDAgb2JqCjgwCmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3ggWzAgMCA1OTUuMjggODQxLjg5XS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgMSAwIFI+Pj4+L0NvbnRlbnRzIDIgMCBSL1BhcmVudCA1IDAgUj4+CmVuZG9iagoKMSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2EvRW5jb2RpbmcvV2luQW5zaUVuY29kaW5nPj4KZW5kb2JqCgo1IDAgb2JqCjw8L1R5cGUvUGFnZXMvQ291bnQgMS9LaWRzWzQgMCBSXT4+CmVuZG9iagoKNiAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgNSAwIFI+PgplbmRvYmoKCjcgMCBvYmoKPDwvUHJvZHVjZXIoanNwZGYgMS41LjMgc2Njc2MyMykgL0NyZWF0aW9uRGF0ZShEOjIwMTkwODAxMTYzMDUwLTA1JzAwJyk+PgplbmRvYmoKCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDI1OSAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxNjYgMDAwMDAgbiAKMDAwMDAwMDE4NSAwMDAwMCBuIAowMDAwMDAwMzQ3IDAwMDAwIG4gCjAwMDAwMDA0MDYgMDAwMDAgbiAKMDAwMDAwMDQ1NiAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgOC9Sb290IDYgMCBSL0luZm8gNyAwIFI+PgpzdGFydHhyZWYKNTE4CiUlRU9GCg==";
  
  // 2. Mock a template matching CommercialPublishing.tsx structure
  const template = {
    basePdf: BLANK_PDF,
    schemas: [
      [
        {
          name: 'span_1',
          type: 'text',
          position: { x: 50, y: 50 },
          width: 50,
          height: 10,
          fontSize: 14,
          fontName: 'NotoSansJP',
          fontColor: '#ff0000', // Red, simulating correction
        },
        {
          name: 'span_2',
          type: 'text',
          position: { x: 50, y: 70 },
          width: 80,
          height: 15,
          fontSize: 16,
          fontName: 'NotoSansJP',
        }
      ]
    ]
  };

  // 3. Setup Inputs (what text should go in the template fields)
  const inputs = [{
    'span_1': 'テスト合同会社', // Test LLC
    'span_2': '鈴木 一郎'       // Suzuki Ichiro
  }];
  
  // 4. Fetch NotoSansJP correctly, replicating CommercialPublishing's Japanese font support fix.
  console.log("Fetching Japanese fonts...");
  const res = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp@5.0.18/files/noto-sans-jp-japanese-400-normal.woff');
  const jpData = await res.arrayBuffer();
  
  const jpFont = {
    ...getDefaultFont(),
    NotoSansJP: {
      fallback: true,
      data: jpData
    }
  };
  if (jpFont.Roboto) {
    jpFont.Roboto.fallback = false;
  }

  // 5. Generate PDF
  console.log("Generating modified PDF...");
  const pdfOutput = await generate({ 
    template, 
    inputs, 
    options: { font: jpFont } 
  });
  
  // 6. Save the resulting PDF and report
  await fs.writeFile('output_test.pdf', Buffer.from(pdfOutput));
  console.log("Success! Modified PDF has been saved as 'output_test.pdf'");
}

testPdfGenerate().catch(console.error);
