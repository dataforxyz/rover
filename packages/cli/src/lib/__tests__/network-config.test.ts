import { describe, expect, it } from 'vitest';
import {
  generateNetworkScript,
  validateNetworkRules,
} from '../network-config.js';

describe('generateNetworkScript', () => {
  it('allows configured sidecar hostnames in allowlist mode', () => {
    const script = generateNetworkScript(
      {
        mode: 'allowlist',
        rules: [{ host: 'api.github.com' }],
        allowDns: true,
        allowLocalhost: true,
      },
      { serviceHostnames: ['postgres', 'redis'] }
    );

    expect(script).toContain(
      '# Always allow service container traffic on the task network'
    );
    expect(script).toContain("for ip in $(resolve_host 'postgres'); do");
    expect(script).toContain("for ip in $(resolve_host 'redis'); do");
    expect(script).toContain('sudo iptables -A OUTPUT -d "$ip" -j ACCEPT');
    expect(
      script.indexOf('sudo iptables -A OUTPUT -o lo -j ACCEPT')
    ).toBeLessThan(script.indexOf("for ip in $(resolve_host 'postgres'); do"));
    expect(
      script.indexOf('sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT')
    ).toBeLessThan(script.indexOf("for ip in $(resolve_host 'postgres'); do"));
  });

  it('exempts configured sidecar hostnames before blocklist rules', () => {
    const script = generateNetworkScript(
      {
        mode: 'blocklist',
        rules: [{ host: '10.0.0.0/8' }],
        allowDns: true,
        allowLocalhost: true,
      },
      { serviceHostnames: ['postgres'] }
    );

    expect(
      script.indexOf("for ip in $(resolve_host 'postgres'); do")
    ).toBeLessThan(
      script.indexOf('sudo iptables -A OUTPUT -d 10.0.0.0/8 -j DROP')
    );
  });

  it('still allows loopback and DNS needed for sidecar discovery when disabled explicitly', () => {
    const script = generateNetworkScript(
      {
        mode: 'allowlist',
        rules: [],
        allowDns: false,
        allowLocalhost: false,
      },
      { serviceHostnames: ['postgres'] }
    );

    expect(script).toContain(
      '# Allow loopback traffic required for sidecar service discovery'
    );
    expect(script).toContain(
      '# Allow DNS required for sidecar service discovery'
    );
    expect(
      script.indexOf('sudo iptables -A OUTPUT -o lo -j ACCEPT')
    ).toBeLessThan(script.indexOf("for ip in $(resolve_host 'postgres'); do"));
    expect(
      script.indexOf('sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT')
    ).toBeLessThan(script.indexOf("for ip in $(resolve_host 'postgres'); do"));
  });

  it('single-quotes domain hosts to prevent shell expansion', () => {
    const script = generateNetworkScript({
      mode: 'allowlist',
      rules: [{ host: 'example.com' }],
      allowDns: true,
      allowLocalhost: true,
    });

    expect(script).toContain("for ip in $(resolve_host 'example.com'); do");
    // Must NOT use double quotes for domain hosts
    expect(script).not.toContain('resolve_host "example.com"');
  });

  it('sanitizes description to remove shell metacharacters', () => {
    const script = generateNetworkScript({
      mode: 'allowlist',
      rules: [
        {
          host: '10.0.0.1',
          description: 'safe$(malicious)\nnewline`injection`',
        },
      ],
      allowDns: true,
      allowLocalhost: true,
    });

    // Newlines and shell metacharacters must be stripped from the comment
    expect(script).not.toContain('$(malicious)');
    expect(script).not.toContain('`injection`');
    // The sanitized description should still appear as a comment on the rule line
    expect(script).toContain('# safemalicious newlineinjection');
  });

  it('sanitizes description in blocklist mode', () => {
    const script = generateNetworkScript({
      mode: 'blocklist',
      rules: [{ host: '10.0.0.1', description: 'test\n; rm -rf /' }],
      allowDns: true,
      allowLocalhost: true,
    });

    expect(script).not.toContain('; rm -rf /');
    expect(script).toContain('# test rm -rf /');
  });

  it('throws when rules contain shell metacharacters', () => {
    expect(() =>
      generateNetworkScript({
        mode: 'allowlist',
        rules: [{ host: '$(whoami)' }],
        allowDns: true,
        allowLocalhost: true,
      })
    ).toThrow(/Invalid network rules/);
  });

  it('uses IP directly for IP/CIDR hosts without resolve_host', () => {
    const script = generateNetworkScript({
      mode: 'allowlist',
      rules: [{ host: '192.168.1.0/24' }],
      allowDns: true,
      allowLocalhost: true,
    });

    expect(script).toContain(
      'sudo iptables -A OUTPUT -d 192.168.1.0/24 -j ACCEPT'
    );
    // IP/CIDR rules should not call resolve_host — only the function
    // definition should be present, not any invocation for this rule.
    expect(script).not.toContain("resolve_host '192.168.1.0/24'");
  });
});

describe('validateNetworkRules', () => {
  it('accepts valid domain hosts', () => {
    const result = validateNetworkRules([
      { host: 'api.github.com' },
      { host: '10.0.0.1' },
      { host: '192.168.0.0/16' },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects hosts with shell metacharacters', () => {
    const dangerous = [
      '$(whoami)',
      '`whoami`',
      'host;rm -rf /',
      'host&echo pwned',
      'host|cat /etc/passwd',
      'host\nnewline',
      'host$(cmd)',
    ];

    for (const host of dangerous) {
      const result = validateNetworkRules([{ host }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid characters');
    }
  });

  it('rejects empty hosts', () => {
    const result = validateNetworkRules([{ host: '' }]);
    expect(result.valid).toBe(false);
  });

  it('rejects hosts with angle brackets and other special chars', () => {
    const result = validateNetworkRules([{ host: '<script>' }]);
    expect(result.valid).toBe(false);
  });
});
