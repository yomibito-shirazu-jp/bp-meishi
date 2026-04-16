const fs = require('fs');

const code = `
export const uploadPdfToStorage = async (file: File): Promise<string | null> => {
  const supabase = getSupabase();
  if (!supabase) return null;
  const fileName = Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9.\\-_]/g, '');
  try {
    const { data, error } = await supabase.storage.from('uploads').upload(fileName, file);
    if (error) { console.warn('Storage error:', error); return null; }
    const { data: { publicUrl } } = supabase.storage.from('uploads').getPublicUrl(fileName);
    return publicUrl;
  } catch (err) {
    console.warn('Storage exception:', err);
    return null;
  }
};
`;

fs.appendFileSync('services/supabase.ts', code);
console.log('Appended to supabase.ts');
