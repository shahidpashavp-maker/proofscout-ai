import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult } from '../tinyfish.js';

export type ComparisonVerdict = 'AGREEMENT' | 'PARTIAL AGREEMENT' | 'CONTRADICTORY EVIDENCE' | 'INSUFFICIENT EVIDENCE';
export type ComparisonPassage = { text: string; sourceUrl: string; sourceTitle: string; independent: boolean; relation: 'agrees' | 'disagrees' | 'context differs' | 'unassessed' };
export type ComparisonGroup = { id: string; statement: string; verdict: ComparisonVerdict; explanation: string; passages: ComparisonPassage[]; independentSourceCount: number };

const STOP_WORDS = new Set('a an and are as at be been by for from has have in is it of on or that the their this to was were with'.split(' '));
const POPULATION_TERMS = new Set('adults children infants women men patients workers households residents citizens participants users students older younger'.split(' '));
const CONTEXT_TERMS = new Set('global worldwide international national regional urban rural us usa america american canada canadian mexico brazil uk england british europe european asia asian africa african india indian china chinese japan japanese australia australian california texas'.split(' '));

function normalize(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9%.$-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokens(text: string): Set<string> {
  return new Set((normalize(text).match(/[a-z0-9]+(?:\.[0-9]+)?%?/g) ?? []).filter((token) => !STOP_WORDS.has(token)).map(stem));
}

function related(left: string, right: string): boolean {
  const a = tokens(left);
  const b = tokens(right);
  const shared = [...a].filter((token) => b.has(token)).length;
  const similarity = shared / new Set([...a, ...b]).size;
  return shared >= 3 && similarity >= 0.42;
}

function numbers(text: string): string[] {
  return text.match(/\b\d[\d,.]*(?:%|\s?(?:million|billion|thousand|years?|months?|days?))?\b/gi) ?? [];
}

function dates(text: string): string[] {
  return text.match(/\b(?:19|20)\d{2}\b/g) ?? [];
}

function populations(text: string): string[] {
  const found = (normalize(text).match(/[a-z]+/g) ?? []).filter((word) => POPULATION_TERMS.has(word));
  return [...new Set(found)];
}

function contexts(text: string): string[] {
  return [...new Set((normalize(text).match(/[a-z]+/g) ?? []).filter((word) => CONTEXT_TERMS.has(word)))];
}

function hasNegation(text: string): boolean {
  return /\b(not|no|never|without|neither|cannot|doesn't|isn't|wasn't|weren't)\b/i.test(text);
}

function duplicatePages(left: FetchResult, right: FetchResult): boolean {
  if (left.url === right.url) return true;
  const a = normalize(left.text);
  const b = normalize(right.text);
  if (a && a === b) return true;
  const aTokens = tokens(left.text);
  const bTokens = tokens(right.text);
  if (Math.min(aTokens.size, bTokens.size) < 30) return false;
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return shared / union >= 0.88;
}

function definitionContext(text: string): string {
  return normalize(text.match(/\b(?:defines?|defined as|measured as|refers to|definition of|measure of)\b[^.!?;]*/i)?.[0] ?? '');
}

function comparePair(left: EvidenceClaim, right: EvidenceClaim): 'agrees' | 'disagrees' | 'context differs' {
  const leftDates = dates(left.claim);
  const rightDates = dates(right.claim);
  const differentDates = leftDates.length > 0 && rightDates.length > 0 && leftDates.join('|') !== rightDates.join('|');
  const leftPopulation = populations(left.claim);
  const rightPopulation = populations(right.claim);
  const differentPopulations = leftPopulation.length > 0 && rightPopulation.length > 0 && leftPopulation.join('|') !== rightPopulation.join('|');
  const leftContext = contexts(left.claim);
  const rightContext = contexts(right.claim);
  const differentContext = leftContext.length > 0 && rightContext.length > 0 && leftContext.join('|') !== rightContext.join('|');
  const leftNumbers = numbers(left.claim);
  const rightNumbers = numbers(right.claim);
  const differentNumbers = leftNumbers.length > 0 && rightNumbers.length > 0 && [...leftNumbers].sort().join('|') !== [...rightNumbers].sort().join('|');
  const leftDefinition = definitionContext(left.claim);
  const rightDefinition = definitionContext(right.claim);
  const definitionsDiffer = Boolean(leftDefinition || rightDefinition) && leftDefinition !== rightDefinition;

  if (differentDates || differentPopulations || differentContext || definitionsDiffer) return 'context differs';
  if (hasNegation(left.claim) !== hasNegation(right.claim) || differentNumbers) return 'disagrees';
  return 'agrees';
}

export function compareClaims(claims: EvidenceClaim[], pages: FetchResult[]): ComparisonGroup[] {
  const validClaims = claims.filter((claim) => typeof claim.claim === 'string' && claim.claim.trim());
  const pageByProvenance = new Map(pages.map((page) => [`${page.url}\n${page.title}`, page]));
  const pageParents = pages.map((_page, index) => index);
  const findPage = (index: number): number => pageParents[index] === index ? index : (pageParents[index] = findPage(pageParents[index]));
  pages.forEach((left, leftIndex) => pages.forEach((right, rightIndex) => {
    if (rightIndex > leftIndex && duplicatePages(left, right)) pageParents[findPage(leftIndex)] = findPage(rightIndex);
  }));
  const sourceCluster = (page: FetchResult) => {
    const pageIndex = pages.findIndex((item) => item.url === page.url && item.title === page.title);
    return pageIndex < 0 ? `${page.url}\n${page.title}` : `source-${findPage(pageIndex)}`;
  };
  const clusterCounts = new Map<string, number>();
  pages.forEach((page) => clusterCounts.set(sourceCluster(page), (clusterCounts.get(sourceCluster(page)) ?? 0) + 1));
  const parent = validClaims.map((_claim, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left: number, right: number) => { parent[find(left)] = find(right); };
  const pairResults: Array<{ left: number; right: number; relation: 'agrees' | 'disagrees' | 'context differs'; independent: boolean }> = [];

  for (let left = 0; left < validClaims.length; left++) {
    for (let right = left + 1; right < validClaims.length; right++) {
      const a = validClaims[left];
      const b = validClaims[right];
      if (!a.sourceUrl || !a.sourceTitle || !b.sourceUrl || !b.sourceTitle || a.sourceUrl === b.sourceUrl || !related(a.claim, b.claim)) continue;
      const sourceA = pageByProvenance.get(`${a.sourceUrl}\n${a.sourceTitle}`);
      const sourceB = pageByProvenance.get(`${b.sourceUrl}\n${b.sourceTitle}`);
      if (!sourceA || !sourceB || sourceA.error || sourceB.error) continue;
      const independent = sourceCluster(sourceA) !== sourceCluster(sourceB);
      const relation = comparePair(a, b);
      pairResults.push({ left, right, relation, independent });
      union(left, right);
    }
  }

  const components = new Map<number, number[]>();
  validClaims.forEach((_claim, index) => components.set(find(index), [...(components.get(find(index)) ?? []), index]));
  return [...components.values()].map((indexes, groupIndex) => {
    const memberSet = new Set(indexes);
    const pairs = pairResults.filter((pair) => memberSet.has(pair.left) && memberSet.has(pair.right));
    const independentSources = new Set<string>();
    const passages: ComparisonPassage[] = [];
    for (const index of indexes) {
      const claim = validClaims[index];
      const page = claim.sourceUrl && claim.sourceTitle ? pageByProvenance.get(`${claim.sourceUrl}\n${claim.sourceTitle}`) : undefined;
      if (!page || page.error || !claim.sourceUrl || !claim.sourceTitle) {
        passages.push({ text: claim.claim, sourceUrl: claim.sourceUrl || '', sourceTitle: claim.sourceTitle || 'Source provenance unavailable', independent: false, relation: 'unassessed' });
      } else {
        if (!passages.some((passage) => passage.sourceUrl === page.url)) passages.push({ text: claim.claim, sourceUrl: page.url, sourceTitle: page.title, independent: clusterCounts.get(sourceCluster(page)) === 1, relation: 'unassessed' });
      }
    }
    for (const pair of pairs) if (pair.independent) {
      for (const index of [pair.left, pair.right]) {
        const claim = validClaims[index];
        const page = pageByProvenance.get(`${claim.sourceUrl}\n${claim.sourceTitle}`);
        if (page) independentSources.add(sourceCluster(page));
      }
    }
    for (const pair of pairs) {
      const relation = pair.independent ? pair.relation : undefined;
      for (const index of [pair.left, pair.right]) {
        const claim = validClaims[index];
        const passage = passages.find((item) => item.sourceUrl === claim.sourceUrl);
        if (passage && relation) {
          passage.relation = relation === 'disagrees' ? 'disagrees' : relation === 'context differs' ? 'context differs' : 'agrees';
        }
      }
    }

    const hasMissingProvenance = indexes.some((index) => {
      const claim = validClaims[index];
      return !claim.sourceUrl || !claim.sourceTitle || !pageByProvenance.has(`${claim.sourceUrl}\n${claim.sourceTitle}`);
    });
    let verdict: ComparisonVerdict = 'INSUFFICIENT EVIDENCE';
    let explanation = hasMissingProvenance
      ? 'Source provenance is missing or could not be matched to fetched content, so this claim cannot be compared reliably.'
      : 'No sufficiently related claim from another independent source was found.';
    if (independentSources.size >= 2) {
      if (pairs.some((pair) => pair.independent && pair.relation === 'disagrees')) {
        verdict = 'CONTRADICTORY EVIDENCE';
        explanation = 'Independent sources make conflicting claims about the same details.';
      } else if (pairs.some((pair) => pair.independent && pair.relation === 'context differs')) {
        verdict = 'PARTIAL AGREEMENT';
        const dated = pairs.some((pair) => pair.independent && dates(validClaims[pair.left].claim).join('|') !== dates(validClaims[pair.right].claim).join('|'));
        const populationDiffers = pairs.some((pair) => pair.independent && populations(validClaims[pair.left].claim).join('|') !== populations(validClaims[pair.right].claim).join('|'));
        const contextDiffers = pairs.some((pair) => pair.independent && contexts(validClaims[pair.left].claim).join('|') !== contexts(validClaims[pair.right].claim).join('|'));
        explanation = dated
          ? 'The claims concern different dates or reporting periods; the difference alone is not a direct contradiction.'
          : populationDiffers
            ? 'The claims refer to different populations, so their results are not directly comparable.'
            : contextDiffers
              ? 'The claims refer to different regions or settings, so their results are not directly comparable.'
            : 'The claims may use different definitions or measurement context, so they are not treated as direct contradictions.';
      } else if (pairs.some((pair) => pair.independent && pair.relation === 'agrees')) {
        verdict = 'AGREEMENT';
        explanation = 'Independent sources make substantially similar claims in comparable contexts.';
      }
    } else if (pairs.length > 0) {
      explanation = 'The matching pages appear to be copies or near-copies, so they count as one source rather than independent agreement.';
    }
    const statement = validClaims[indexes[0]].claim;
    return { id: `comparison-${groupIndex}`, statement, verdict, explanation, passages, independentSourceCount: independentSources.size };
  });
}

export function compareStoredResearch(claims: EvidenceClaim[], pages: FetchResult[]): ComparisonGroup[] {
  return compareClaims(claims, pages);
}
