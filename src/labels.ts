import {
  requiredLabelsForProject, SYSTEM_LABELS, WORKFLOW_STATE_LABELS,
} from './tracker/github.js';
import { acceptsAllIssues } from './triage/intake.js';
import type { ProjectConfig } from './types.js';

/** Labels this tool owns and may remove when a project stops using them. */
export const OWNED_LABELS: readonly string[] = [
  ...SYSTEM_LABELS,
  ...WORKFLOW_STATE_LABELS,
  'agent-complex',
];

export function desiredLabels(project: ProjectConfig): string[] {
  return requiredLabelsForProject(project.ready_label, acceptsAllIssues(project), project.workflow_mode === 'github');
}

/**
 * Remove only owned labels that the project no longer desires; never touch a
 * label this tool did not create (e.g. bug, priority, or a custom ready label).
 */
export function planLabelSync(project: ProjectConfig, existing: readonly string[]): { create: string[]; remove: string[] } {
  const desired = desiredLabels(project);
  const owned = project.workflow_mode === 'github'
    ? [...OWNED_LABELS, project.ready_label]
    : [...OWNED_LABELS];
  return {
    create: desired.filter(label => !existing.includes(label)),
    remove: existing.filter(label => owned.includes(label) && !desired.includes(label)),
  };
}
