/**
 * Network configuration utilities for container sandboxes.
 * Handles generation of iptables rules for network filtering.
 */

import { isIPv4 as nodeIsIPv4, isIPv6 as nodeIsIPv6, isIP } from 'node:net';
import type { NetworkConfig, NetworkRule } from 'rover-schemas';

/**
 * Characters that are unsafe in shell contexts (command substitution,
 * variable expansion, statement separators, etc.).  Used to reject
 * host values and sanitize description values before they are embedded
 * in generated bash scripts.
 */
const SHELL_UNSAFE_CHARS = /[`$();&|!{}\n\r\\]/;

/**
 * Sanitize a rule description so it is safe to embed as a bash comment.
 * Strips control characters and any characters that could break out of
 * a comment context (e.g. newlines).
 */
function sanitizeDescription(description: string): string {
  // Replace newlines, carriage returns and other control chars with spaces,
  // then collapse multiple spaces.
  return description
    .replace(/[\n\r\t]/g, ' ')
    .replace(/[`$();&|!{}\\]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Merge network configurations from project and task levels.
 * Task-level config takes full precedence over project-level config.
 */
export function mergeNetworkConfig(
  projectConfig?: NetworkConfig,
  taskConfig?: NetworkConfig
): NetworkConfig | undefined {
  // Task config takes full precedence
  if (taskConfig) {
    return taskConfig;
  }

  // Fall back to project config
  return projectConfig;
}

/**
 * Check if a string is a valid CIDR notation.
 * Returns { valid: boolean, isV6: boolean } for valid CIDRs.
 */
function parseCIDR(host: string): { valid: boolean; isV6: boolean } | null {
  if (!host.includes('/')) {
    return null;
  }

  const parts = host.split('/');
  if (parts.length !== 2) {
    return null;
  }

  const [ip, prefixStr] = parts;
  const ipVersion = isIP(ip);

  if (ipVersion === 0) {
    return null;
  }

  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0) {
    return null;
  }

  const maxPrefix = ipVersion === 6 ? 128 : 32;
  if (prefix > maxPrefix) {
    return null;
  }

  return { valid: true, isV6: ipVersion === 6 };
}

/**
 * Check if a string is an IPv4 address (with optional CIDR).
 */
function isIPv4(host: string): boolean {
  if (host.includes('/')) {
    const cidr = parseCIDR(host);
    return cidr !== null && !cidr.isV6;
  }
  return nodeIsIPv4(host);
}

/**
 * Check if a string is an IPv6 address (with optional CIDR).
 */
function isIPv6(host: string): boolean {
  if (host.includes('/')) {
    const cidr = parseCIDR(host);
    return cidr !== null && cidr.isV6;
  }
  return nodeIsIPv6(host);
}

/**
 * Check if a string is an IP address or CIDR notation.
 */
function isIPOrCIDR(host: string): boolean {
  return isIPv4(host) || isIPv6(host);
}

/**
 * Generate the bash script section for network filtering.
 * Returns empty string if network filtering is disabled.
 */
export function generateNetworkScript(
  config: NetworkConfig | undefined,
  options: { serviceHostnames?: string[] } = {}
): string {
  if (!config || config.mode === 'allowall') {
    return '';
  }

  const lines: string[] = [
    '',
    '# ========================================',
    '# Network Filtering Configuration',
    '# ========================================',
    '',
    'configure_network_filtering() {',
    `  local mode="${config.mode}"`,
    '',
    '  echo "Configuring network filtering (mode: $mode)"',
    '',
    '  # Install iptables if not available (Debian)',
    '  if ! command -v iptables &> /dev/null; then',
    '    echo "Installing iptables..."',
    '    sudo apt-get update && sudo apt-get install -y --no-install-recommends iptables &> /dev/null || true',
    '  fi',
    '',
    '  # Function to resolve hostname to IPs (both IPv4 and IPv6)',
    '  resolve_host() {',
    '    local host="$1"',
    '    # Check if already an IP or CIDR',
    '    if [[ "$host" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+(/[0-9]+)?$ ]] || [[ "$host" =~ : ]]; then',
    '      echo "$host"',
    '      return',
    '    fi',
    '    # Try nslookup first (gets both IPv4 and IPv6)',
    '    if command -v nslookup &> /dev/null; then',
    '      nslookup "$host" 2>/dev/null | grep -E "^Address:" | grep -v "#" | awk \'{print $2}\' | sort -u',
    '      return',
    '    fi',
    '    # Fallback to getent (may only return one address type)',
    '    getent hosts "$host" 2>/dev/null | awk \'{print $1}\' | sort -u',
    '  }',
    '',
  ];

  // Validate rules before embedding them in the generated script.
  if (config.rules && config.rules.length > 0) {
    const validation = validateNetworkRules(config.rules);
    if (!validation.valid) {
      throw new Error(`Invalid network rules: ${validation.errors.join('; ')}`);
    }
  }

  if (config.mode === 'allowlist') {
    lines.push(...generateAllowlistScript(config, options.serviceHostnames));
  } else if (config.mode === 'blocklist') {
    lines.push(...generateBlocklistScript(config, options.serviceHostnames));
  }

  lines.push(
    '',
    '  echo "Network filtering configured successfully"',
    '}',
    '',
    '# Apply network filtering',
    'configure_network_filtering',
    ''
  );

  return lines.join('\n');
}

/**
 * Generate iptables rules for allowlist mode (deny all except listed).
 */
function generateAllowlistScript(
  config: NetworkConfig,
  serviceHostnames: string[] = []
): string[] {
  const hasServiceHostnames = serviceHostnames.some(Boolean);
  const lines: string[] = [
    '  # Allowlist mode: Block all traffic except explicitly allowed',
    '',
    '  # Set default policy to drop all outgoing traffic',
    '  sudo iptables -P OUTPUT DROP 2>/dev/null || true',
    '  sudo ip6tables -P OUTPUT DROP 2>/dev/null || true',
    '',
    '  # Allow established connections (for responses to our requests)',
    '  sudo iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true',
    '  sudo ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true',
    '',
  ];

  if (config.allowLocalhost !== false || hasServiceHostnames) {
    lines.push(
      config.allowLocalhost === false && hasServiceHostnames
        ? '  # Allow loopback traffic required for sidecar service discovery'
        : '  # Allow localhost/loopback traffic',
      '  sudo iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true',
      '  sudo ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true',
      ''
    );
  }

  if (config.allowDns !== false || hasServiceHostnames) {
    lines.push(
      config.allowDns === false && hasServiceHostnames
        ? '  # Allow DNS required for sidecar service discovery'
        : '  # Allow DNS resolution',
      '  sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true',
      '  sudo iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true',
      '  sudo ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true',
      '  sudo ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true',
      ''
    );
  }

  lines.push(...generateServiceHostnameRules(serviceHostnames));

  // Add rules for each allowed host
  if (config.rules && config.rules.length > 0) {
    lines.push('  # Allow specific hosts');
    for (const rule of config.rules) {
      const comment = rule.description
        ? ` # ${sanitizeDescription(rule.description)}`
        : '';
      const trimmedHost = rule.host.trim();
      if (isIPOrCIDR(trimmedHost)) {
        // Direct IP/CIDR - no resolution needed
        if (isIPv6(trimmedHost)) {
          lines.push(
            `  sudo ip6tables -A OUTPUT -d ${trimmedHost} -j ACCEPT 2>/dev/null || true${comment}`
          );
        } else {
          lines.push(
            `  sudo iptables -A OUTPUT -d ${trimmedHost} -j ACCEPT 2>/dev/null || true${comment}`
          );
        }
      } else {
        // Domain - needs resolution; single-quote the host to prevent
        // shell expansion of any residual special characters.
        const safeHost = trimmedHost.replace(/'/g, "'\"'\"'");
        lines.push(`  # ${trimmedHost.replace(/[\n\r]/g, ' ')}${comment}`);
        lines.push(`  for ip in $(resolve_host '${safeHost}'); do`);
        lines.push('    if [[ "$ip" =~ : ]]; then');
        lines.push(
          '      sudo ip6tables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true'
        );
        lines.push('    else');
        lines.push(
          '      sudo iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true'
        );
        lines.push('    fi');
        lines.push('  done');
      }
    }
  }

  return lines;
}

/**
 * Generate iptables rules for blocklist mode (allow all except listed).
 */
function generateBlocklistScript(
  config: NetworkConfig,
  serviceHostnames: string[] = []
): string[] {
  const lines: string[] = [
    '  # Blocklist mode: Allow all traffic except explicitly blocked',
    '',
  ];

  lines.push(...generateServiceHostnameRules(serviceHostnames));

  // Add rules for each blocked host
  if (config.rules && config.rules.length > 0) {
    lines.push('  # Block specific hosts');
    for (const rule of config.rules) {
      const comment = rule.description
        ? ` # ${sanitizeDescription(rule.description)}`
        : '';
      const trimmedHost = rule.host.trim();
      if (isIPOrCIDR(trimmedHost)) {
        // Direct IP/CIDR - no resolution needed
        if (isIPv6(trimmedHost)) {
          lines.push(
            `  sudo ip6tables -A OUTPUT -d ${trimmedHost} -j DROP 2>/dev/null || true${comment}`
          );
        } else {
          lines.push(
            `  sudo iptables -A OUTPUT -d ${trimmedHost} -j DROP 2>/dev/null || true${comment}`
          );
        }
      } else {
        // Domain - needs resolution; single-quote the host to prevent
        // shell expansion of any residual special characters.
        const safeHost = trimmedHost.replace(/'/g, "'\"'\"'");
        lines.push(`  # ${trimmedHost.replace(/[\n\r]/g, ' ')}${comment}`);
        lines.push(`  for ip in $(resolve_host '${safeHost}'); do`);
        lines.push('    if [[ "$ip" =~ : ]]; then');
        lines.push(
          '      sudo ip6tables -A OUTPUT -d "$ip" -j DROP 2>/dev/null || true'
        );
        lines.push('    else');
        lines.push(
          '      sudo iptables -A OUTPUT -d "$ip" -j DROP 2>/dev/null || true'
        );
        lines.push('    fi');
        lines.push('  done');
      }
    }
  }

  return lines;
}

function generateServiceHostnameRules(serviceHostnames: string[]): string[] {
  const uniqueHostnames = [...new Set(serviceHostnames.filter(Boolean))];
  if (uniqueHostnames.length === 0) {
    return [];
  }

  // Validate service hostnames against shell metacharacters, same as rule hosts.
  for (const hostname of uniqueHostnames) {
    if (SHELL_UNSAFE_CHARS.test(hostname) || /[<>"|?*]/.test(hostname)) {
      throw new Error(`Invalid characters in service hostname: ${hostname}`);
    }
  }

  const lines: string[] = [
    '  # Always allow service container traffic on the task network',
  ];

  for (const hostname of uniqueHostnames) {
    const safeHostname = hostname.replace(/'/g, "'\"'\"'");
    lines.push(`  # ${hostname.replace(/[\n\r]/g, ' ')}`);
    lines.push(`  for ip in $(resolve_host '${safeHostname}'); do`);
    lines.push('    if [[ "$ip" =~ : ]]; then');
    lines.push(
      '      sudo ip6tables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true'
    );
    lines.push('    else');
    lines.push(
      '      sudo iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true'
    );
    lines.push('    fi');
    lines.push('  done');
  }

  lines.push('');
  return lines;
}

/**
 * Validation result for network rules.
 */
export interface NetworkRuleValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate network rules for correctness.
 */
export function validateNetworkRules(
  rules: NetworkRule[]
): NetworkRuleValidationResult {
  const errors: string[] = [];

  for (const rule of rules) {
    if (!rule.host || rule.host.trim().length === 0) {
      errors.push('Empty host in network rule');
      continue;
    }

    const host = rule.host.trim();

    // Check for invalid characters — reject shell metacharacters that could
    // allow command injection when the host is embedded in generated scripts.
    if (/[<>"|?*]/.test(host) || SHELL_UNSAFE_CHARS.test(host)) {
      errors.push(`Invalid characters in host: ${host}`);
      continue;
    }

    // Validate CIDR notation if present
    if (host.includes('/')) {
      const cidr = parseCIDR(host);
      if (cidr === null) {
        errors.push(`Invalid CIDR notation: ${host}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
