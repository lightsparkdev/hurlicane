import type { CreateJobRequest, Repo, Worktree } from '../../shared/types.js';

export interface TemplateFilter {
  field: string;
  op: 'eq' | 'neq';
  value: string;
}

export interface TemplateBinding {
  templateId: string;
  filters: TemplateFilter[];
}

export interface EyePrompts {
  eventTemplates: Record<string, TemplateBinding[]>;
  disabledEvents: string[];
  globalFilters: TemplateFilter[];
  botName: string;
}

export interface EyeConfig {
  webhookSecret: string;
  author: string;
}

export interface OrchestratorClient {
  createJob(req: CreateJobRequest): Promise<{ id: string; title: string } | null>;
  getRepoByName(name: string): Promise<Repo | null>;
  listRepos(): Promise<Repo[]>;
  getWorktreeByBranch(branch: string): Promise<Worktree | null>;
  createWorktree(branch: string, repoId: string, trackExisting?: boolean): Promise<Worktree | null>;
  cleanupBranch(branch: string, merged?: boolean): Promise<{ found: boolean; cancelledJobs: number } | null>;
  getPrompts(): Promise<EyePrompts>;
}
