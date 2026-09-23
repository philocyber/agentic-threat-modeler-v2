const SECURITY_TERMS = new Set(['api', 'jwt', 'iam', 'xss', 'sql', 'llm'])

export function tokenizeSecurityText(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((token) =>
    token.length >= 4 || SECURITY_TERMS.has(token),
  )
}
