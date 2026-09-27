export const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

// Resolve document-relative links without letting them leave the selected workspace.
export function documentReference(
  document: string,
  url: string,
): { path: string; hash: string } | null {
  try {
    const [target, fragment = ''] = url.split('#');
    const decoded = decodeURIComponent(target.split('?')[0]);
    if (
      /^[a-z][a-z\d+.-]*:/i.test(decoded) ||
      decoded.startsWith('//') ||
      /[\\\x00-\x1f]/.test(decoded)
    )
      return null;
    const parts = decoded.startsWith('/') ? [] : document.split('/').slice(0, -1);
    if (!decoded) return { path: document, hash: decodeURIComponent(fragment) };
    for (const part of decoded.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    return { path: parts.join('/'), hash: decodeURIComponent(fragment) };
  } catch {
    return null;
  }
}
