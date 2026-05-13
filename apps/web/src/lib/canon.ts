// Port of canon_name() from /apps/jobs/legacy/predict_investable_players.py
// Lowercase, strip punctuation, collapse whitespace.
export function canonName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
