/**
 * 名刺の固定フィールドテンプレート。
 * 検出された spans を意味カテゴリに自動マッピングし、25項目で俯瞰できるようにする。
 *
 * マッピングの優先順位:
 *   1. fieldCategories[spanId]（Gemini AI correction が付けたカテゴリ）
 *   2. テキストパターン（郵便番号・電話・メール・URL 等の正規表現）
 *   3. font_class + 位置（最大の mincho = 氏名、最大の gothic = 会社名 等）
 *   4. いずれも合致しない → 'other'
 */

import { Span } from '../types';

export interface MeishiField {
  key: string;
  label: string;
  hint?: string;
  multi?: boolean;  // 複数スパンが入り得るフィールド（住所・備考等）
}

// 名刺の標準フィールド（25項目）
export const MEISHI_FIELDS: MeishiField[] = [
  { key: 'company',        label: '会社名' },
  { key: 'company_en',     label: '会社名（英）' },
  { key: 'company_kana',   label: '会社名（フリガナ）' },
  { key: 'department',     label: '部署', multi: true },
  { key: 'title',          label: '役職', multi: true },
  { key: 'name',           label: '氏名' },
  { key: 'name_kana',      label: '氏名（フリガナ）' },
  { key: 'name_en',        label: '氏名（英）' },
  { key: 'postal',         label: '郵便番号' },
  { key: 'address',        label: '住所', multi: true },
  { key: 'address_en',     label: '住所（英）', multi: true },
  { key: 'building',       label: 'ビル名/階', hint: '任意' },
  { key: 'phone',          label: '電話' },
  { key: 'phone_ext',      label: '内線', hint: '任意' },
  { key: 'fax',            label: 'FAX' },
  { key: 'mobile',         label: '携帯' },
  { key: 'email',          label: 'メール' },
  { key: 'url',            label: 'URL' },
  { key: 'sns',            label: 'SNS', hint: 'X / LinkedIn 等' },
  { key: 'qr',             label: 'QRコード', hint: '任意' },
  { key: 'logo',           label: 'ロゴ', hint: '画像要素' },
  { key: 'slogan',         label: 'キャッチコピー', hint: '任意', multi: true },
  { key: 'cert',           label: '認定マーク / 資格', hint: '任意', multi: true },
  { key: 'note',           label: 'その他注記', hint: '任意', multi: true },
  { key: 'other',          label: '未分類', multi: true },
];

// 正規表現でカテゴリ推定
const REGEX_RULES: Array<{ key: string; re: RegExp }> = [
  { key: 'postal',  re: /〒?\s*\d{3}[-ー–—]\d{4}/ },
  { key: 'phone',   re: /(?:TEL|Tel|電話)[.:：]?\s*[\d\-ー()（）\s]{8,}/ },
  { key: 'fax',     re: /(?:FAX|Fax|ファックス)[.:：]?\s*[\d\-ー()（）\s]{8,}/ },
  { key: 'mobile',  re: /(?:Mobile|MOB|携帯|090|080|070)[\d\-ー\s]{9,}/ },
  { key: 'email',   re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { key: 'url',     re: /https?:\/\/|www\./ },
  { key: 'address', re: /都|道|府|県|市|区|町|村|丁目|番地|[0-9]+[-ー]?[0-9]+[-ー]?[0-9]+/ },
];

const isAscii = (s: string) => /^[\x20-\x7E\s]+$/.test(s);
const hasKana = (s: string) => /[ぁ-んァ-ヶー]/.test(s);
const hasKanji = (s: string) => /[一-龯々]/.test(s);

/**
 * 各 span を 25種の名刺フィールドに割り当てる。
 * 戻り値: fieldKey → span[] のマップ（同じ key に複数 span が入ることあり）
 */
export const classifySpans = (
  spans: Span[],
  fieldCategories?: Record<string, string>,
): Record<string, Span[]> => {
  const out: Record<string, Span[]> = {};
  MEISHI_FIELDS.forEach(f => { out[f.key] = []; });

  // 位置で上→下にソートして名前・会社名の推定に使う
  const sorted = [...spans].sort((a, b) => a.y_pct - b.y_pct);

  // company / name 用の候補をサイズ順で
  const gothicBig = [...spans]
    .filter(s => (s.font_class === 'gothic' || s.font_class === 'gothic_bold') && hasKanji(s.text))
    .sort((a, b) => b.size_pt - a.size_pt);
  const minchoBig = [...spans]
    .filter(s => s.font_class === 'mincho' && (hasKanji(s.text) || hasKana(s.text)))
    .sort((a, b) => b.size_pt - a.size_pt);

  const assigned = new Set<string>();
  const assign = (key: string, span: Span) => {
    if (assigned.has(span.id)) return;
    out[key].push(span);
    assigned.add(span.id);
  };

  for (const s of sorted) {
    if (assigned.has(s.id)) continue;
    const text = (s.text || '').trim();
    if (!text) { assign('other', s); continue; }

    // 1) Gemini の fieldCategories を最優先
    const cat = fieldCategories?.[s.id];
    if (cat && out[cat] !== undefined) { assign(cat, s); continue; }
    // cat が同じカテゴリ名で微妙に違う場合もマップ (label → 商品名 など名刺以外)
    if (cat) {
      // 名刺カテゴリ外 → other
      assign('other', s);
      continue;
    }

    // 2) 正規表現でカテゴリ推定
    let matched: string | null = null;
    for (const { key, re } of REGEX_RULES) {
      if (re.test(text)) { matched = key; break; }
    }
    if (matched) { assign(matched, s); continue; }

    // 3) 氏名推定: 最大の mincho（漢字2-4文字 + スペース + 漢字）
    if (minchoBig[0]?.id === s.id && text.length <= 10) {
      assign('name', s);
      continue;
    }
    // 氏名（英）: ASCII のみで単語が2-3個
    if (isAscii(text) && /^[A-Z][a-z]+(\s+[A-Z][a-z]+){1,2}$/.test(text) && !out.name_en.length) {
      assign('name_en', s);
      continue;
    }
    // フリガナ: カナのみ
    if (hasKana(text) && !hasKanji(text) && !isAscii(text)) {
      if (text.length <= 20 && !out.name_kana.length) {
        assign('name_kana', s);
        continue;
      }
    }

    // 4) 会社名推定: 最大の gothic で漢字を含む
    if (gothicBig[0]?.id === s.id) {
      assign('company', s);
      continue;
    }
    // 会社名(英): 大型 ASCII
    if (isAscii(text) && s.size_pt >= 10 && !out.company_en.length) {
      assign('company_en', s);
      continue;
    }

    // 5) 部署・役職の推定
    if (/部|課|室|チーム|グループ|センター|事業|サポート|営業|製作|マーケティング/.test(text)) {
      assign('department', s);
      continue;
    }
    if (/社長|代表|取締役|部長|課長|係長|主任|マネージャー|ディレクター|CEO|CTO|CFO|President|Manager|Director/.test(text)) {
      assign('title', s);
      continue;
    }

    // 6) fallback: その他
    assign('other', s);
  }

  return out;
};
