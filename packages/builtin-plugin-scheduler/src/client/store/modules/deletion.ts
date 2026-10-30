import type { TaskView } from '../../types'
import { defineStore } from 'dsh-tauri/client'

export interface DeletionFeedback {
  seq: number
  kind: 'deleted' | 'deleteFailed'
  taskId: string
  name: string
  error?: string
}

interface DeletionState {
  pendingTask: TaskView | null
  deletingTaskId: string | null
  feedback: DeletionFeedback | null
  feedbackSeq: number
}

export const deletion = defineStore({
  state: (): DeletionState => ({
    pendingTask: null,
    deletingTaskId: null,
    feedback: null,
    feedbackSeq: 0,
  }),
  actions: {
    request(task: TaskView) {
      if (this.deletingTaskId !== null)
        return
      this.pendingTask = task
    },
    begin(): TaskView | null {
      if (this.pendingTask === null || this.deletingTaskId !== null)
        return null
      this.deletingTaskId = this.pendingTask.id
      return this.pendingTask
    },
    finish(task: TaskView, outcome: { ok: boolean, error?: string }) {
      if (this.deletingTaskId !== task.id)
        return
      this.pendingTask = null
      this.deletingTaskId = null
      this.feedbackSeq += 1
      this.feedback = {
        seq: this.feedbackSeq,
        kind: outcome.ok ? 'deleted' : 'deleteFailed',
        taskId: task.id,
        name: task.name,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }
    },
    cancel() {
      if (this.deletingTaskId === null)
        this.pendingTask = null
    },
    dismiss(seq?: number) {
      if (seq === undefined || this.feedback?.seq === seq)
        this.feedback = null
    },
  },
})
