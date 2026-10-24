import type { FetchResult } from './tinyfish.js';

export type EvidenceClaim = { id: string; claim: string; sourceUrl: string; sourceTitle: string; conflict: boolean };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9%.$-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function keyFor(sentence: string): string {
  // Heuristic: sentences sharing their first words and numeric/date evidence are compared.
  const words = normalize(sentence).split(' ');
  const valueIndex = words.findIndex((word) => /\d/.test(word));
  const subject = (valueIndex >= 0 ? words.slice(0, valueIndex) : words.slice(0, 8)).slice(0, 7).join(' ');
  return subject.length > 14 ? subject : '';
}

export function buildEvidence(pages: FetchResult[]): EvidenceClaim[] {
  const claims = pages.flatMap((page, pageIndex) => {
    if (page.error || !page.text.trim()) return [];
    const sentences = page.text.replace(/\[(.*?)\]\((https?:\/\/[^)]+)\)/g, '$1').replace(/https?:\/\/\S+/g, '').split(/(?<=[.!?])\s+|\n+/);
    return sentences.map((sentence) => sentence.replace(/^\s*[-*#>\d.)]+\s*/, '').trim())
      .filter((sentence) => sentence.length >= 30 && sentence.length <= 500 && !/^https?:\/\//i.test(sentence))
      .slice(0, 30)
      .map((claim, index) => ({ id: `${pageIndex}-${index}`, claim, sourceUrl: page.url, sourceTitle: page.title, conflict: false }));
  });
  const groups = new Map<string, EvidenceClaim[]>();
  for (const claim of claims) {
    const key = keyFor(claim.claim);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  for (const group of groups.values()) {
    const values = new Set(group.map((item) => normalize(item.claim).match(/\b\d[\d,.]*(?:%|\s?(?:million|billion|thousand|years?|months?|days?))?\b/g)?.join('|') ?? ''));
    if (group.length > 1 && values.size > 1) group.forEach((item) => { item.conflict = true; });
  }
  return claims;
}
