export enum TELEMETRY_FROM {
  CLI = 'cli',
  EXTENSION = 'extension',
}

export default class Telemetry {
  static load(_from: TELEMETRY_FROM): Telemetry {
    return new Telemetry();
  }

  static disableTelemetry(): void {}

  static enableTelemetry(): void {}

  async shutdown(): Promise<void> {}

  getUserId(): string {
    return 'test-user';
  }

  isDisabled(): boolean {
    return false;
  }
}
