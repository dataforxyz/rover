import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import styles from './task-card.css.mjs';

@customElement('task-card')
export class TaskCard extends LitElement {
  @property({ type: Object }) task: any = null;
  @property({ type: Number }) nowMs = Date.now();
  @state() private showDropdown = false;

  static styles = styles;

  connectedCallback() {
    super.connectedCallback();
    // Add global click listener to close dropdown when clicking outside
    document.addEventListener('click', this.handleDocumentClick.bind(this));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleDocumentClick.bind(this));
  }

  private handleDocumentClick(event: Event) {
    // Close dropdown if clicking outside the component
    if (!this.contains(event.target as Node)) {
      this.showDropdown = false;
    }
  }

  private getStatusIcon(status?: string): string {
    switch (status?.toUpperCase()) {
      case 'COMPLETED':
        return 'codicon-pass';
      case 'MERGED':
        return 'codicon-git-merge';
      case 'PUSHED':
        return 'codicon-repo-push';
      case 'FAILED':
        return 'codicon-error';
      case 'PAUSED':
        return 'codicon-debug-pause';
      case 'RUNNING':
      case 'ITERATING':
      case 'INITIALIZING':
      case 'IN_PROGRESS':
        return 'codicon-sync spin';
      case 'INSTALLING':
        return 'codicon-desktop-download';
      default:
        return 'codicon-circle-large-outline';
    }
  }

  private getStatusClass(status?: string): string {
    return status?.toLowerCase() || 'pending';
  }

  private getStatusName(status?: string): string {
    if (!status) return 'Unknown';

    // Capitalize
    const label =
      `${status.charAt(0)}${status.substring(1).toLowerCase()}`.replaceAll(
        '_',
        ' '
      );

    return label;
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private formatTimeInfo(task: any): string {
    const completed = this.parseDate(task.completedAt);
    if (completed) return `Completed ${this.formatRelativeTime(completed)}`;

    const failed = this.parseDate(task.failedAt);
    if (failed) return `Failed ${this.formatRelativeTime(failed)}`;

    const paused = this.parseDate(task.pausedAt);
    if (task.status === 'PAUSED' && paused) {
      return `Paused ${this.formatRelativeTime(paused)}`;
    }

    const started = this.parseDate(task.startedAt);
    if (
      started &&
      (
        task.status === 'RUNNING' ||
        task.status === 'INITIALIZING' ||
        task.status === 'INSTALLING' ||
        task.status === 'ITERATING' ||
        task.status === 'IN_PROGRESS'
      )
    ) {
      return `Started ${this.formatRelativeTime(started)}`;
    }

    return '';
  }

  private formatRelativeTime(date: Date): string {
    const diffMs = this.nowMs - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  private formatDuration(startDate: Date): string {
    const diffMs = this.nowMs - startDate.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 60) return `${diffMins}m`;
    const remainingMins = diffMins % 60;
    return remainingMins > 0
      ? `${diffHours}h ${remainingMins}m`
      : `${diffHours}h`;
  }

  private formatAbsoluteTime(value?: string): string {
    const date = this.parseDate(value);
    return date ? date.toLocaleString() : '';
  }

  private getTimelineEntries(task: any): Array<{ label: string; value: string }> {
    const entries: Array<{ label: string; value: string }> = [];
    const pushEntry = (label: string, value?: string) => {
      const date = this.parseDate(value);
      if (!date) return;
      if (entries.some(entry => entry.value === value)) return;
      entries.push({ label, value: value! });
    };

    pushEntry('started', task.startedAt);
    pushEntry('paused', task.pausedAt);
    pushEntry('failed', task.failedAt);
    pushEntry('completed', task.completedAt);

    return entries;
  }

  private inspectTask() {
    const event = new CustomEvent('inspect-task', {
      detail: { taskId: this.task.id, taskTitle: this.task.title },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  private executeTaskAction(event: Event, action: string, taskStatus?: string) {
    event.stopPropagation();

    const customEvent = new CustomEvent('task-action', {
      detail: {
        action,
        taskId: this.task.id,
        taskTitle: this.task.title,
        taskStatus: taskStatus || this.task.status,
      },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(customEvent);
  }

  private showMoreActions(event: Event) {
    event.stopPropagation();
    this.showDropdown = !this.showDropdown;
  }

  private getMoreActions() {
    const isCompleted = ['completed', 'merged', 'pushed'].includes(
      this.task.status?.toLowerCase()
    );

    const actions = [
      {
        action: 'openWorkspace',
        label: 'Open Workspace',
        icon: 'folder-opened',
      },
    ];

    if (isCompleted) {
      actions.push(
        { action: 'pushBranch', label: 'Push Branch', icon: 'repo-push' },
        { action: 'iterateTask', label: 'Iterate Task', icon: 'debug-restart' }
      );
    }

    actions.push({ action: 'deleteTask', label: 'Delete Task', icon: 'trash' });

    return actions;
  }

  private handleMoreAction(event: Event, action: string) {
    event.stopPropagation();
    this.showDropdown = false;
    this.executeTaskAction(event, action);
  }

  render() {
    if (!this.task) return html``;

    const timeInfo = this.formatTimeInfo(this.task);
    const isRunning = [
      'running',
      'initializing',
      'installing',
      'iterating',
      'in_progress',
    ].includes(this.task.status?.toLowerCase());
    const isCompleted = ['completed', 'merged', 'pushed'].includes(
      this.task.status?.toLowerCase()
    );
    const isFailed = this.task.status?.toLowerCase() === 'failed';
    const isPaused = this.task.status?.toLowerCase() === 'paused';
    const startedDate = this.parseDate(this.task.startedAt);
    const timelineEntries = this.getTimelineEntries(this.task);

    return html`
      <div class="task-card">
        <!-- Header with Task ID and Title -->
        <div class="task-header">
          <span class="task-id">#${this.task.id}</span>
          <div class="task-title">${this.task.title}</div>
        </div>

        <!-- Metadata line with status badge and timestamp -->
        <div class="task-metadata">
          <span class="status-badge ${this.getStatusClass(this.task.status)}">
            <i class="codicon ${this.getStatusIcon(this.task.status)}"></i>
            ${this.getStatusName(this.task.status)}
          </span>
          ${
            this.task.workflowName
              ? html`<span class="task-workflow">${this.task.workflowName}</span>`
              : ''
          }
          ${
            timeInfo
              ? html`<span class="task-timestamp">${timeInfo}</span>`
              : ''
          }
          ${
            startedDate && (isRunning || isPaused || isFailed)
              ? html`<span class="task-progress">runtime ${this.formatDuration(startedDate)}</span>`
              : ''
          }
          ${
            this.task.progress !== undefined && this.task.progress > 0
              ? html`<span class="task-progress">${this.task.progress}%</span>`
              : ''
          }
          ${
            this.task.currentStep && isRunning
              ? html`<span class="task-progress">${this.task.currentStep}</span>`
              : ''
          }
        </div>

        ${
          timelineEntries.length > 0
            ? html`
              <div class="task-timeline">
                ${timelineEntries.map(
                  entry => html`
                    <div
                      class="timeline-chip ${entry.label}"
                      title=${this.formatAbsoluteTime(entry.value)}
                    >
                      <span class="timeline-label">${entry.label}</span>
                      <span class="timeline-age">${this.formatRelativeTime(new Date(entry.value))}</span>
                      <span class="timeline-absolute">${this.formatAbsoluteTime(entry.value)}</span>
                    </div>
                  `
                )}
              </div>
            `
            : ''
        }

        <!-- Action buttons -->
        <div class="task-actions">
          <!-- Left side: Quick actions + More actions -->
          <div class="action-group">
            <!-- Primary actions based on status -->
            ${
              isCompleted
                ? html`
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'gitCompare')}
                    title="Compare changes made by this task"
                  >
                    <i class="codicon codicon-diff"></i>
                    Compare
                  </button>
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'mergeTask')}
                    title="Merge task changes into main branch"
                  >
                    <i class="codicon codicon-git-merge"></i>
                    Merge
                  </button>
                `
                : ''
            }
            ${
              isRunning
                ? html`
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'viewLogs', this.task.status)}
                    title="View task execution logs"
                  >
                    <i class="codicon codicon-output"></i>
                    Logs
                  </button>
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'openShell')}
                    title="Open shell in task workspace"
                  >
                    <i class="codicon codicon-terminal"></i>
                    Shell
                  </button>
                `
                : ''
            }
            ${
              isFailed
                ? html`
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'viewLogs', this.task.status)}
                    title="View error logs"
                  >
                    <i class="codicon codicon-output"></i>
                    Error Logs
                  </button>
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'iterateTask')}
                    title="Retry or fix this task"
                  >
                    <i class="codicon codicon-debug-restart"></i>
                    Retry
                  </button>
                `
                : ''
            }
            ${
              isPaused
                ? html`
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'resumeTask')}
                    title="Resume this paused task"
                  >
                    <i class="codicon codicon-debug-continue"></i>
                    Resume
                  </button>
                  <button
                    class="action-button"
                    @click=${(e: Event) =>
                      this.executeTaskAction(e, 'viewLogs', this.task.status)}
                    title="View task logs"
                  >
                    <i class="codicon codicon-output"></i>
                    Logs
                  </button>
                `
                : ''
            }

            <!-- More actions button -->
            <div class="more-actions-container">
              <button
                class="action-button"
                @click=${(e: Event) => this.showMoreActions(e)}
                title="More actions"
              >
                <i class="codicon codicon-ellipsis"></i>
              </button>

              ${
                this.showDropdown
                  ? html`
                    <div class="more-actions-dropdown">
                      ${this.getMoreActions().map(
                        action => html`
                          <button
                            class="dropdown-item ${
                              action.action === 'deleteTask' ? 'danger' : ''
                            }"
                            @click=${(e: Event) =>
                              this.handleMoreAction(e, action.action)}
                            title=${action.label}
                          >
                            <i class="codicon codicon-${action.icon}"></i>
                            ${action.label}
                          </button>
                        `
                      )}
                    </div>
                  `
                  : ''
              }
            </div>
          </div>

          <!-- Right side: Details button -->
          <button
            class="details-button"
            @click=${this.inspectTask}
            title="View detailed task information"
          >
            <i class="codicon codicon-info"></i>
            Details
          </button>
        </div>
      </div>
    `;
  }
}
