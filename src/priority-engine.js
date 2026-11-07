/**
 * Priority Engine - Intelligent task scheduling with dynamic prioritization
 * 
 * Features:
 * - Dynamic priority scoring based on task complexity, urgency, and resource cost
 * - Task timeout with queue wait limits
 * - Task preemption (high-priority can interrupt low-priority)
 * - Task decomposition (complex tasks auto-split into sub-queues)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './instance-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Priority Scoring System
// ─────────────────────────────────────────────────────────────────────────────

// Every name here must match src/tools.js verbatim. A misspelled name does not
// throw - it silently falls through to the default score of 70, which is how
// an entire scoring tier can appear to work while doing nothing.
const TOOL_CATEGORIES = {
  // Read operations (lowest cost, highest priority)
  read: {
    tools: [
      'browser_read', 'browser_observe', 'browser_find_element',
      'browser_find_text', 'browser_at', 'browser_tabs',
      'browser_ai_status', 'browser_capabilities', 'browser_tool_index',
      'browser_queue_status', 'browser_wait_until_ready', 'browser_capability_guide',
      'browser_hosts', 'browser_screenshot', 'browser_cookies',
      'browser_storage_read', 'browser_network_summary'
    ],
    baseScore: 10,
    cost: 'low'
  },
  // Quick write operations (medium cost)
  quickWrite: {
    tools: [
      'browser_fill', 'browser_select', 'browser_choose',
      'browser_key', 'browser_action', 'browser_hover'
    ],
    baseScore: 40,
    cost: 'medium'
  },
  // Complex write operations (high cost, need verification)
  complexWrite: {
    tools: [
      'browser_click', 'browser_upload', 'browser_drag',
      'browser_dialog', 'browser_storage_write', 'browser_init_script',
      'browser_network_rules', 'browser_recipe_run', 'browser_popup'
    ],
    baseScore: 60,
    cost: 'high'
  },
  // Navigation/structural operations (highest cost)
  navigation: {
    tools: [
      'browser_navigate', 'browser_close', 'browser_navigate_verified',
      'browser_open', 'browser_windows', 'browser_downloads'
    ],
    baseScore: 80,
    cost: 'critical'
  }
};

/**
 * Calculate task priority score (lower = higher priority)
 * Considers: tool type, complexity, urgency, resource cost
 */
function calculatePriority(task) {
  const { name, args, metadata } = task;
  
  // 1. Base score from tool category
  let baseScore = 70; // default "normal"
  for (const [category, config] of Object.entries(TOOL_CATEGORIES)) {
    if (config.tools.includes(name)) {
      baseScore = config.baseScore;
      break;
    }
  }
  
  // 2. Complexity modifier (from metadata or heuristics)
  let complexityModifier = 0;
  if (metadata?.complexity) {
    switch (metadata.complexity) {
      case 'simple': complexityModifier = -20; break;
      case 'moderate': complexityModifier = 0; break;
      case 'complex': complexityModifier = +20; break;
      case 'critical': complexityModifier = +40; break;
    }
  }
  
  // 3. Urgency modifier
  let urgencyModifier = 0;
  if (metadata?.urgency) {
    switch (metadata.urgency) {
      case 'high': urgencyModifier = -30; break;
      case 'medium': urgencyModifier = 0; break;
      case 'low': urgencyModifier = +20; break;
    }
  }
  
  // 4. Resource cost modifier
  let resourceModifier = 0;
  if (metadata?.resourceCost) {
    switch (metadata.resourceCost) {
      case 'minimal': resourceModifier = -10; break;
      case 'moderate': resourceModifier = 0; break;
      case 'heavy': resourceModifier = +15; break;
    }
  }
  
  // 5. AI-assisted discovery bonus (if task includes discovery results)
  let discoveryBonus = 0;
  if (metadata?.aiAssisted && metadata.discoveryConfidence) {
    if (metadata.discoveryConfidence >= 0.9) discoveryBonus = -15;
    else if (metadata.discoveryConfidence >= 0.7) discoveryBonus = -10;
    else if (metadata.discoveryConfidence >= 0.5) discoveryBonus = -5;
  }
  
  // Calculate final score
  const finalScore = Math.max(1, Math.min(100, baseScore + complexityModifier + urgencyModifier + resourceModifier + discoveryBonus));
  
  return {
    score: finalScore,
    name: getPriorityName(finalScore),
    breakdown: { baseScore, complexityModifier, urgencyModifier, resourceModifier, discoveryBonus }
  };
}

function getPriorityName(score) {
  if (score <= 20) return 'critical';
  if (score <= 40) return 'high';
  if (score <= 60) return 'medium';
  if (score <= 80) return 'normal';
  return 'low';
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enhanced priority queue with timeout and preemption support
 */
class PriorityQueue {
  constructor(maxSize = 32) {
    this.queue = [];
    this.maxSize = maxSize;
    this.waitTimeoutMs = 60000; // 60 seconds max wait in queue
    this.stats = {
      totalEnqueued: 0,
      totalExecuted: 0,
      totalTimedOut: 0,
      totalPreempted: 0
    };
  }
  
  /**
   * Enqueue task with priority scoring
   * Returns: { status: 'queued' | 'rejected' | 'preempted', taskId, priority }
   */
  enqueue(task) {
    // Calculate priority
    const { score, name: priorityName, breakdown } = calculatePriority(task);

    // Check queue capacity. A successful preemption only makes ROOM; the new
    // task still has to be inserted below. The old early return reported a
    // preemption and silently dropped the high-priority task that caused it.
    let preemptedTaskId = null;
    if (this.queue.length >= this.maxSize) {
      const preempted = this.tryPreemption(task);
      if (!preempted) {
        this.stats.totalTimedOut++;
        return { status: 'rejected', reason: 'queue_full', queueLength: this.queue.length };
      }
      this.stats.totalPreempted++;
      preemptedTaskId = preempted.id;
    }

    // Add to queue with priority ordering
    const entry = {
      ...task,
      priority: score,
      priorityName,
      enqueuedAt: Date.now(),
      executedAt: null,
      status: 'queued'
    };
    
    // Insert in sorted order (lower score = higher priority)
    const insertIndex = this.queue.findIndex(item => item.priority > score);
    if (insertIndex === -1) {
      this.queue.push(entry);
    } else {
      this.queue.splice(insertIndex, 0, entry);
    }
    
    this.stats.totalEnqueued++;
    
    return {
      status: preemptedTaskId ? 'preempted' : 'queued',
      taskId: task.id,
      priority: priorityName,
      position: this.queue.indexOf(entry) + 1,
      ...(preemptedTaskId ? { preemptedTask: preemptedTaskId } : {}),
      breakdown
    };
  }

  /**
   * Try to preempt a lower-priority task to make room
   */
  tryPreemption(newTask) {
    const newPriority = calculatePriority(newTask).score;

    // The queue is kept sorted ascending by score, so the lowest-priority
    // queued entry is the last qualifying one. Walk backwards WITHOUT mutating
    // the array: reverse() is in-place, and calling .reverse() on the object
    // returned by find() used to throw TypeError on every preemption attempt.
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const candidate = this.queue[i];
      if (candidate.priority > newPriority && candidate.status === 'queued') {
        this.queue.splice(i, 1);
        candidate.status = 'preempted';
        return candidate;
      }
    }
    return null;
  }
  
  /**
   * Dequeue highest priority task
   */
  dequeue() {
    if (this.queue.length === 0) return null;
    
    const task = this.queue.shift();
    task.status = 'executing';
    task.executedAt = Date.now();
    this.stats.totalExecuted++;
    
    return task;
  }
  
  /**
   * Check for timed-out tasks and remove them
   */
  cleanupTimeouts() {
    const now = Date.now();
    const timedOut = [];
    
    this.queue = this.queue.filter(entry => {
      const waitTime = now - entry.enqueuedAt;
      if (waitTime > this.waitTimeoutMs) {
        timedOut.push(entry);
        entry.status = 'timed_out';
        this.stats.totalTimedOut++;
        return false;
      }
      return true;
    });
    
    return timedOut;
  }
  
  /**
   * Get queue status
   */
  getStatus() {
    const byPriority = {};
    
    this.queue.forEach(entry => {
      if (!byPriority[entry.priorityName]) {
        byPriority[entry.priorityName] = [];
      }
      byPriority[entry.priorityName].push({
        id: entry.id,
        name: entry.name,
        position: this.queue.indexOf(entry) + 1,
        waitTime: Date.now() - entry.enqueuedAt
      });
    });
    
    return {
      length: this.queue.length,
      maxSize: this.maxSize,
      utilization: this.queue.length / this.maxSize,
      byPriority,
      stats: { ...this.stats },
      avgWaitTime: this.calculateAvgWaitTime()
    };
  }
  
  calculateAvgWaitTime() {
    if (this.queue.length === 0) return 0;
    const now = Date.now();
    const totalWait = this.queue.reduce((sum, entry) => sum + (now - entry.enqueuedAt), 0);
    return Math.round(totalWait / this.queue.length);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Decomposition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decompose complex tasks into smaller sub-tasks
 * Returns array of sub-tasks with dependencies
 */
function decomposeTask(task) {
  const { name, args, metadata } = task;
  
  // Identify tasks that can be decomposed
  const decomposableTasks = [
    'browser_navigate', 'browser_click', 'browser_fill', 'browser_upload'
  ];
  
  if (!decomposableTasks.includes(name)) {
    return { original: task, subTasks: [], canDecompose: false };
  }
  
  // Heuristic decomposition based on task type
  if (name === 'browser_navigate' && args?.url) {
    // Advisory pre-check and post-verify steps. The original task is NOT one of
    // its own sub-tasks: including it made the caller enqueue the same navigate
    // twice. These are suggestions, never dispatched commands.
    return {
      original: task,
      subTasks: [
        {
          id: randomUUID(),
          name: 'browser_page_info',
          args: {},
          parentTaskId: task.id,
          metadata: { phase: 'pre-check', complexity: 'simple', urgency: 'high' }
        },
        {
          id: randomUUID(),
          name: 'browser_observe',
          args: {},
          parentTaskId: task.id,
          metadata: { phase: 'post-verify', complexity: 'moderate', urgency: 'medium' }
        }
      ],
      canDecompose: true
    };
  }
  
  if (name === 'browser_click' && args?.elementId) {
    // Same rule as navigate: advisory checks only, never a duplicate write.
    return {
      original: task,
      subTasks: [
        {
          id: randomUUID(),
          name: 'browser_find_element',
          args: { selector: args.selector, timeout: 3000 },
          parentTaskId: task.id,
          metadata: { phase: 'pre-check', complexity: 'simple', urgency: 'high' }
        },
        {
          id: randomUUID(),
          name: 'browser_observe',
          args: {},
          parentTaskId: task.id,
          metadata: { phase: 'post-verify', complexity: 'moderate', urgency: 'medium' }
        }
      ],
      canDecompose: true
    };
  }
  
  return { original: task, subTasks: [], canDecompose: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export {
  calculatePriority,
  PriorityQueue,
  decomposeTask,
  getPriorityName,
  TOOL_CATEGORIES
};
