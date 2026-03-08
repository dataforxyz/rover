/**
 * Agent-local condition evaluator.
 *
 * Unlike the core package, agent loop execution treats missing prerequisite
 * outputs as "not ready yet", so both `==` and `!=` return false until the
 * referenced step output exists.
 */

const CAPTURING_CONDITION_REGEX =
  /^steps\.([\w-]+)\.outputs\.([\w-]+)\s*(==|!=)\s*(.+)$/;

function normalizeBoolean(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 'yes' || lower === 'on') return 'true';
  if (lower === 'false' || lower === 'no' || lower === 'off') return 'false';
  return value;
}

function splitOnLogicalOr(condition: string): string[] {
  const parts: string[] = [];
  const regex = /\s*\|\|\s*(?=steps\.)/g;
  let lastIndex = 0;
  let match = regex.exec(condition);

  while (match !== null) {
    parts.push(condition.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    match = regex.exec(condition);
  }

  parts.push(condition.slice(lastIndex));

  return parts;
}

function hasLogicalAnd(condition: string): boolean {
  return /\s*&&\s*(?=steps\.)/.test(condition);
}

export function evaluateCondition(
  condition: string,
  stepsOutput: Map<string, Map<string, string>>
): boolean {
  if (hasLogicalAnd(condition)) {
    console.warn(
      `Warning: "&&" (AND) operator is not supported in conditions. Use separate steps with "if" conditions instead. Condition: "${condition}"`
    );
    return false;
  }

  const parts = splitOnLogicalOr(condition);
  return parts.some(part => evaluateSingleCondition(part.trim(), stepsOutput));
}

function evaluateSingleCondition(
  condition: string,
  stepsOutput: Map<string, Map<string, string>>
): boolean {
  const trimmed = condition.trim();
  const match = trimmed.match(CAPTURING_CONDITION_REGEX);

  if (!match) {
    console.warn(
      `Warning: clause "${condition}" does not match expected format "steps.<id>.outputs.<name> == <value>"`
    );
    return false;
  }

  const [, stepId, outputName, operator, rawValue] = match;
  const expectedValue = rawValue.trim();
  const stepOutputs = stepsOutput.get(stepId);

  if (!stepOutputs) {
    return false;
  }

  const actualValue = stepOutputs.get(outputName);
  if (actualValue === undefined) {
    return false;
  }

  const normActual = normalizeBoolean(actualValue);
  const normExpected = normalizeBoolean(expectedValue);

  if (operator === '==') {
    return normActual === normExpected;
  }

  return normActual !== normExpected;
}
