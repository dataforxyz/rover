import { describe, expect, it } from 'vitest';
import { generateNetworkScript } from '../network-config.js';

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
    expect(script).toContain('for ip in $(resolve_host "postgres"); do');
    expect(script).toContain('for ip in $(resolve_host "redis"); do');
    expect(script).toContain('sudo iptables -A OUTPUT -d "$ip" -j ACCEPT');
    expect(
      script.indexOf('sudo iptables -A OUTPUT -o lo -j ACCEPT')
    ).toBeLessThan(script.indexOf('for ip in $(resolve_host "postgres"); do'));
    expect(
      script.indexOf('sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT')
    ).toBeLessThan(script.indexOf('for ip in $(resolve_host "postgres"); do'));
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
      script.indexOf('for ip in $(resolve_host "postgres"); do')
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
    ).toBeLessThan(script.indexOf('for ip in $(resolve_host "postgres"); do'));
    expect(
      script.indexOf('sudo iptables -A OUTPUT -p udp --dport 53 -j ACCEPT')
    ).toBeLessThan(script.indexOf('for ip in $(resolve_host "postgres"); do'));
  });
});
