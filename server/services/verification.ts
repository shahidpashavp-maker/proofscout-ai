import { randomBytes } from 'node:crypto';
import type { EvidenceClaim } from '../evidence.js';
import type { FetchResult } from '../tinyfish.js';

export type VerificationVerdict = 'SUPPORTED' | 'PARTIALLY SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT EVIDENCE';
export type EvidencePassage = { text: string; sourceUrl: string; sourceTitle: string; stance: 'supports' | 'contradicts' };
export type VerificationResult = EvidenceClaim & {
  verdict: VerificationVerdict;
  explanation: string;
  passages: EvidencePassage[];
  basis: 'source support, not independent confirmation of objective truth';
};

const STOP_WORDS = new Set('a an and are as at be been by for from has have in is it of on or that the their this to was were with'.split(' '));
const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'neither', 'cannot', "can't", "doesn't", "isn't", "wasn't", "weren't"]);
const VERIFICATION_TTL_MS = 20 * 60 * 1000;
const MAX_VERIFICATION_RECORDS = 200;
const verificationRecords = new Map<string, { expiresAt: number; claims: EvidenceClaim[]; pages: FetchResult[]; question: string }>();

export function createVerificationRecord(claims: EvidenceClaim[], pages: FetchResult[], question = ''): string {
  const now = Date.now();
  for (const [id, record] of verificationRecords) if (record.expiresAt <= now) verificationRecords.delete(id);
  while (verificationRecords.size >= MAX_VERIFICATION_RECORDS) {
    const oldest = verificationRecords.keys().next().value;
    if (!oldest) break;
    verificationRecords.delete(oldest);
  }
  const id = randomBytes(24).toString('base64url');
  verificationRecords.set(id, { expiresAt: now + VERIFICATION_TTL_MS, claims, pages, question });
  return id;
}

export function verifyStoredClaims(id: string): VerificationResult[] | undefined {
  const record = verificationRecords.get(id);
  if (!record || record.expiresAt <= Date.now()) {
    verificationRecords.delete(id);
    return undefined;
  }
  return verifyClaims(record.claims, record.pages);
}

export function getStoredResearch(id: string): { claims: EvidenceClaim[]; pages: FetchResult[]; question: string } | undefined {
  const record = verificationRecords.get(id);
  if (!record || record.expiresAt <= Date.now()) {
    verificationRecords.delete(id);
    return undefined;
  }
  return { claims: record.claims, pages: record.pages, question: record.question };
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?%?/g)?.filter((word) => !STOP_WORDS.has(word)) ?? [];
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

function overlap(claim: string, passage: string): { claimCoverage: number; passageCoverage: number; shared: Set<string> } {
  const claimWords = new Set(tokens(claim));
  const passageWords = new Set(tokens(passage));
  const shared = new Set([...claimWords].filter((word) => passageWords.has(word)));
  return {
    claimCoverage: claimWords.size ? shared.size / claimWords.size : 0,
    passageCoverage: passageWords.size ? shared.size / passageWords.size : 0,
    shared,
  };
}

function hasNegation(text: string): boolean {
  return (text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []).some((word) => NEGATIONS.has(word));
}

function numbers(text: string): string[] {
  return text.match(/\b\d[\d,.]*(?:%|\s?(?:million|billion|thousand|years?|months?|days?))?\b/gi) ?? [];
}

function makeResult(claim: EvidenceClaim, verdict: VerificationVerdict, explanation: string, passages: EvidencePassage[]): VerificationResult {
  return { ...claim, verdict, explanation, passages, basis: 'source support, not independent confirmation of objective truth' };
}

export function verifyClaim(claim: EvidenceClaim, pages: FetchResult[]): VerificationResult {
  const origin = pages.find((page) => page.url === claim.sourceUrl && page.title === claim.sourceTitle);
  if (!origin || origin.error || !origin.text.trim()) {
    return makeResult(claim, 'INSUFFICIENT EVIDENCE', 'The original source content is missing or unavailable, so this claim cannot be checked against it.', []);
  }

  const candidates = pages.filter((source) => !source.error && source.text.trim()).flatMap((source) =>
    sentences(source.text).map((passage) => ({ passage, sourceUrl: source.url, sourceTitle: source.title, ...overlap(claim.claim, passage) })))
    .filter((item) => item.shared.size >= 2 && item.claimCoverage >= 0.35)
    .sort((left, right) => right.claimCoverage - left.claimCoverage || right.passageCoverage - left.passageCoverage);
  if (!candidates.length) {
    return makeResult(claim, 'INSUFFICIENT EVIDENCE', 'No relevant passage was located in the fetched sources. This does not establish whether the claim is true or false.', []);
  }

  const claimNegated = hasNegation(claim.claim);
  const claimNumbers = numbers(claim.claim);
  const assessed = candidates.map((item) => {
    const passageNumbers = numbers(item.passage);
    const numericMismatch = claimNumbers.length > 0 && passageNumbers.length > 0 && claimNumbers.every((number) => !passageNumbers.includes(number));
    const contradicts = item.claimCoverage >= 0.6 && item.shared.size >= 3 &&
      (claimNegated !== hasNegation(item.passage) || numericMismatch);
    const supports = !contradicts && item.claimCoverage >= 0.6 && item.shared.size >= 3;
    return { ...item, stance: contradicts ? 'contradicts' as const : 'supports' as const, supports, contradicts };
  });
  const supporting = assessed.filter((item) => item.supports);
  const contradicting = assessed.filter((item) => item.contradicts);
  const toPassage = (item: typeof assessed[number]): EvidencePassage => ({ text: item.passage, sourceUrl: item.sourceUrl, sourceTitle: item.sourceTitle, stance: item.stance });

  if (contradicting.length && supporting.length) {
    return makeResult(claim, 'PARTIALLY SUPPORTED', 'Fetched sources include both supporting and conflicting passages. This reports disagreement among the sources, not a finding about objective truth.', [...supporting.slice(0, 2).map(toPassage), ...contradicting.slice(0, 2).map(toPassage)]);
  }
  if (contradicting.length) {
    return makeResult(claim, 'CONTRADICTED', 'Relevant fetched source passages state a conflicting polarity or numeric value. This is a source-level contradiction, not a finding about objective truth.', contradicting.slice(0, 3).map(toPassage));
  }
  if (supporting.length) {
    return makeResult(claim, 'SUPPORTED', 'Relevant fetched source passages directly match the claim’s main factual details. This indicates source support only, not independent confirmation of objective truth.', supporting.slice(0, 3).map(toPassage));
  }
  const partial = assessed.filter((item) => item.claimCoverage >= 0.35 && item.shared.size >= 2);
  if (partial.length) {
    return makeResult(claim, 'PARTIALLY SUPPORTED', 'Fetched source passages overlap with part of the claim, but do not establish all its details. This indicates source support only, not independent confirmation of objective truth.', partial.slice(0, 3).map(toPassage));
  }
  return makeResult(claim, 'INSUFFICIENT EVIDENCE', 'No relevant passage was located in the fetched sources. This does not establish whether the claim is true or false.', []);
}

export function verifyClaims(claims: EvidenceClaim[], pages: FetchResult[]): VerificationResult[] {
  return claims.map((claim) => verifyClaim(claim, pages));
}

export function isValidVerificationRequest(value: unknown): value is { verificationId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.verificationId === 'string' && /^[A-Za-z0-9_-]{32}$/.test(payload.verificationId);
}
