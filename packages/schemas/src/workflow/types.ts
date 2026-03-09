/**
 * TypeScript types for workflow YAML structure
 * All types are inferred from Zod schemas to ensure consistency
 */

import type z from 'zod';
import type {
  WorkflowInputTypeSchema,
  WorkflowInputSchema,
  WorkflowOutputTypeSchema,
  WorkflowOutputSchema,
  WorkflowDefaultsSchema,
  WorkflowConfigSchema,
  WorkflowAgentToolSchema,
  WorkflowAgentStepSchema,
  WorkflowCommandStepSchema,
  WorkflowConditionalStepSchema,
  WorkflowLoopStepSchema,
  WorkflowParallelStepSchema,
  WorkflowSequentialStepSchema,
  WorkflowStepSchema,
  WorkflowSchema,
} from './schema.js';

// Input types
export type WorkflowInputType = z.infer<typeof WorkflowInputTypeSchema>;
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// Output types
export type WorkflowOutputType = z.infer<typeof WorkflowOutputTypeSchema>;
export type WorkflowOutput = z.infer<typeof WorkflowOutputSchema>;

// Agent tool type
export type WorkflowAgentTool = z.infer<typeof WorkflowAgentToolSchema>;

// Defaults
export type WorkflowDefaults = z.infer<typeof WorkflowDefaultsSchema>;

// Config
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

// Step types - all inferred from Zod schemas
export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;
export type WorkflowCommandStep = z.infer<typeof WorkflowCommandStepSchema>;
export type WorkflowConditionalStep = z.infer<
  typeof WorkflowConditionalStepSchema
>;
export type WorkflowLoopStep = z.infer<typeof WorkflowLoopStepSchema>;
export type WorkflowParallelStep = z.infer<typeof WorkflowParallelStepSchema>;
export type WorkflowSequentialStep = z.infer<
  typeof WorkflowSequentialStepSchema
>;
/**
 * Legacy step types retained for internal type helpers and future use.
 * These are NOT included in WorkflowStepSchema's union, so they will fail
 * runtime validation. Use only for type-level utilities.
 */
export type WorkflowLegacyStep =
  | WorkflowConditionalStep
  | WorkflowParallelStep
  | WorkflowSequentialStep;

// Discriminated union of all step types
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
type AnyWorkflowStep = WorkflowStep | WorkflowLegacyStep;

// Main workflow structure
export type Workflow = z.infer<typeof WorkflowSchema>;

// Type guards for step types
export function isAgentStep(step: AnyWorkflowStep): step is WorkflowAgentStep {
  return step.type === 'agent';
}

export function isCommandStep(
  step: AnyWorkflowStep
): step is WorkflowCommandStep {
  return step.type === 'command';
}

export function isLoopStep(step: AnyWorkflowStep): step is WorkflowLoopStep {
  return step.type === 'loop';
}

export function isConditionalStep(
  step: AnyWorkflowStep
): step is WorkflowConditionalStep {
  return step.type === 'conditional';
}

export function isParallelStep(
  step: AnyWorkflowStep
): step is WorkflowParallelStep {
  return step.type === 'parallel';
}

export function isSequentialStep(
  step: AnyWorkflowStep
): step is WorkflowSequentialStep {
  return step.type === 'sequential';
}
