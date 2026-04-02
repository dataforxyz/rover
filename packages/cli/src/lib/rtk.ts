import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir, type ProjectConfigManager, type TaskDescriptionManager } from 'rover-core';

export interface RtkConfig {
  enabled: boolean;
}

const RTK_CONFIG_FILENAME = 'rtk.json';

export function getRtkConfigPath(): string {
  return join(getConfigDir(), RTK_CONFIG_FILENAME);
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

export function loadRtkConfig(): RtkConfig {
  const envOverride = parseBooleanEnv(process.env.ROVER_RTK);
  if (envOverride !== undefined) {
    return { enabled: envOverride };
  }

  const filePath = getRtkConfigPath();
  if (!existsSync(filePath)) {
    return { enabled: true };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<RtkConfig>;
    return { enabled: parsed.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export function isRtkEnabledByDefault(): boolean {
  return loadRtkConfig().enabled;
}

export function saveRtkConfig(config: RtkConfig): void {
  const filePath = getRtkConfigPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function setRtkEnabledByDefault(enabled: boolean): RtkConfig {
  const next = { enabled };
  saveRtkConfig(next);
  return next;
}

export function resolveRtkEnabled(
  projectConfig?: Pick<ProjectConfigManager, 'rtk'>,
  task?: Pick<TaskDescriptionManager, 'rtkEnabled'>
): boolean {
  if (task?.rtkEnabled !== undefined) {
    return task.rtkEnabled;
  }

  if (projectConfig?.rtk !== undefined) {
    return projectConfig.rtk;
  }

  return isRtkEnabledByDefault();
}
