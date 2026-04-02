export function requiredClaudeCredentials(): boolean {
  if (
    requiredBedrockCredentials() ||
    requiredVertexAiCredentials() ||
    claudeProxyEnabled()
  ) {
    return false;
  }

  return true;
}

export function claudeProxyEnabled(): boolean {
  return !!(
    process.env.ROVER_CLAUDE_PROXY_URL && process.env.ROVER_CLAUDE_PROXY_KEY
  );
}

export function getClaudeProxyConfig(): {
  url: string;
  key: string;
} | null {
  const url = process.env.ROVER_CLAUDE_PROXY_URL;
  const key = process.env.ROVER_CLAUDE_PROXY_KEY;
  if (url && key) {
    return { url, key };
  }
  return null;
}

export function requiredBedrockCredentials(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === '1' ||
    process.env.CLAUDE_CODE_USE_BEDROCK === 'true' ||
    process.env.CLAUDE_CODE_USE_BEDROCK === 'yes'
  );
}

export function requiredVertexAiCredentials(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_VERTEX === '1' ||
    process.env.CLAUDE_CODE_USE_VERTEX === 'true' ||
    process.env.CLAUDE_CODE_USE_VERTEX === 'yes'
  );
}
