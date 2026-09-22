/**
 * Folds the spellings Arabic writers use interchangeably into one form, for
 * **comparison only** — never for display.
 *
 * «أقلام» / «اقلام», «مسطرة» / «مسطره», «مقوّى» / «مقوى» are the same word to
 * every reader and different strings to a database. Unfolded, a search for
 * «اقلام» misses the category named «أقلام», and a uniqueness check lets an
 * admin create «دفاتر مدرسيه» next to «دفاتر مدرسية» — two rows the customer
 * sees as one duplicated entry. Neither fails; both just look careless.
 *
 * Folds: alef forms (أ إ آ ٱ → ا) · taa marbuta (ة → ه) · alef maqsura (ى → ي) ·
 * hamza carriers (ؤ → و, ئ → ي) · diacritics and tatweel (removed) · Arabic-Indic
 * digits (٠-٩ → 0-9) · case and surrounding/duplicate whitespace.
 */
export function normalizeArabic(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[ً-ٰٟۖ-ۭ]/g, '') // tashkeel, superscript alef, Quranic marks
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
