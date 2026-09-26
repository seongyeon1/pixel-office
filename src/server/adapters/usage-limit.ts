// Only provider errors belong here, never task text or tool output.
export function isUsageLimit(error: unknown): boolean {
  const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return /usage[_ -]?limit(?:[_ -]?(?:exceeded|reached))?|insufficient_quota|quota[_ -]?(?:exceeded|exhausted)|rate[_ -]?limit|(?:hit|reached|exceeded|exhausted)\b.{0,40}\b(?:session|weekly|monthly|token|credit|usage|spending)\b.{0,20}\blimit|(?:credit|token)s?\s+(?:exhausted|depleted)|credit balance is too low|(?:사용량|토큰|세션)\s*한도.{0,15}(?:초과|소진)/i.test(
    text,
  );
}
