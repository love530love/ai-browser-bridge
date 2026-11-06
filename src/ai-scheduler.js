/**
 * AI Scheduler - Lightweight AI-assisted task scheduling
 * 
 * Features:
 * - Lightweight task complexity assessment (rule engine + heuristics)
 * - Smart queuing strategy (simple tasks first, complex tasks queued)
 * - Task parallelization suggestions (identify parallelizable sub-tasks)
 * - Conflict detection & resolution (multi-agent conflict warning for same page)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './instance-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task Complexity Assessment (Rule-Based)
// ─────────────────────────────────────────────────────────────────────────────

const COMPLEXITY_RULES = {
  // Simple tasks: direct execution, no verification needed
  simple: {
    criteria: [
      (task) => ['browser_read', 'browser_observe', 'browser_page_info'].includes(task.name),
      (task) => task.name === 'browser_find_text' && (!task.args?.timeout || task.args.timeout <= 3000),
      (task) => task.name === 'browser_get_cookies' || task.name === 'browser_get_storage'
    ],
    score: 10,
    estimatedDuration: 1000 // 1 second
  },
  // Moderate tasks: need basic verification
  moderate: {
    criteria: [
      (task) => ['browser_fill', 'browser_select', 'browser_choose'].includes(task.name),
      (task) => task.name === 'browser_key' && task.args?.keys?.length <= 3,
      (task) => task.name === 'browser_find_element' && !task.args?.selector?.includes('xpath'),
      (task) => task.name === 'browser_navigate' && task.args?.url?.length < 100
    ],
    score: 40,
    estimatedDuration: 3000 // 3 seconds
  },
  // Complex tasks: need verification and error handling
  complex: {
    criteria: [
      (task) => ['browser_click', 'browser_upload', 'browser_drag'].includes(task.name),
      (task) => task.name === 'browser_key' && task.args?.keys?.length > 3,
      (task) => task.name === 'browser_navigate' && task.args?.url?.length >= 100,
      (task) => task.name === 'browser_find_element' && task.args?.selector?.includes('xpath'),
      (task) => task.name === 'browser_dialog'
    ],
    score: 70,
    estimatedDuration: 5000 // 5 seconds
  },
  // Critical tasks: high risk, need manual confirmation or special handling
  critical: {
    criteria: [
      (task) => ['browser_close', 'browser_reload', 'browser_storage_write'].includes(task.name),
      (task) => task.name === 'browser_init_script' || task.name === 'browser_network_rules',
      (task) => task.name === 'browser_recipe_run',
      (task) => task.name === 'browser_navigate' && (task.args?.url?.includes('about:blank') || task.args?.url?.includes('chrome://'))
    ],
    score: 90,
    estimatedDuration: 8000 // 8 seconds
  }
};

/**
 * Assess task complexity using rule-based engine
 * Returns: { complexity: 'simple'|'moderate'|'complex'|'critical', score, estimatedDuration }
 */
function assessComplexity(task) {
  for (const [level, config] of Object.entries(COMPLEXITY_RULES)) {
    for (const criterion of config.criteria) {
      if (criterion(task)) {
        return {
          complexity: level,
          score: config.score,
          estimatedDuration: config.estimatedDuration,
          reason: `${level} task: ${task.name}`
        };
      }
    }
  }
  
  // Default to moderate
  return {
    complexity: 'moderate',
    score: 40,
    estimatedDuration: 3000,
    reason: 'default moderate'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Queuing Strategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smart queuing: simple tasks pass through quickly, complex tasks are queued
 * Returns: { action: 'execute'|'queue'|'defer', priority, reason }
 */
function determineQueueStrategy(task, currentQueueLength) {
  const complexity = assessComplexity(task);
  
  // Simple tasks: always execute immediately (unless queue is very full)
  if (complexity.complexity === 'simple') {
    if (currentQueueLength < 5) {
      return { action: 'execute', priority: 'high', reason: 'simple task, low queue' };
    } else {
      return { action: 'queue', priority: 'medium', reason: 'simple task, but queue full' };
    }
  }
  
  // Moderate tasks: queue if queue length > 10
  if (complexity.complexity === 'moderate') {
    if (currentQueueLength < 10) {
      return { action: 'execute', priority: 'medium', reason: 'moderate task, moderate queue' };
    } else {
      return { action: 'queue', priority: 'medium', reason: 'moderate task, high queue' };
    }
  }
  
  // Complex tasks: always queue, wait for simpler tasks to clear
  if (complexity.complexity === 'complex') {
    return { action: 'queue', priority: 'low', reason: 'complex task, defer to simple tasks' };
  }
  
  // Critical tasks: queue but with high urgency
  if (complexity.complexity === 'critical') {
    return { action: 'queue', priority: 'high', reason: 'critical task, queue but high urgency' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Parallelization Suggestions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identify tasks that can be executed in parallel
 * Returns: { parallelizable: boolean, suggestions: [] }
 */
function suggestParallelization(taskList) {
  const suggestions = [];
  
  // Group tasks by operation type
  const readTasks = taskList.filter(t => ['browser_read', 'browser_observe', 'browser_page_info'].includes(t.name));
  const navigationTasks = taskList.filter(t => ['browser_navigate', 'browser_switch_tab'].includes(t.name));
  const interactionTasks = taskList.filter(t => ['browser_click', 'browser_fill', 'browser_key'].includes(t.name));
  
  // Read tasks can be parallelized (no side effects)
  if (readTasks.length > 1) {
    suggestions.push({
      type: 'parallel_reads',
      tasks: readTasks.map(t => t.id),
      reason: 'Read-only tasks have no side effects and can run in parallel',
      risk: 'low'
    });
  }
  
  // Different tab operations can be parallelized
  const tabSpecificTasks = taskList.filter(t => t.metadata?.tabId);
  const uniqueTabs = new Set(tabSpecificTasks.map(t => t.metadata.tabId));
  if (uniqueTabs.size > 1 && interactionTasks.length > 1) {
    suggestions.push({
      type: 'cross_tab_parallel',
      tasks: interactionTasks.map(t => t.id),
      reason: 'Tasks targeting different tabs can run in parallel',
      risk: 'medium'
    });
  }
  
  return {
    parallelizable: suggestions.length > 0,
    suggestions
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict Detection & Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect potential conflicts between tasks
 * Returns: { conflicts: [], warnings: [] }
 */
function detectConflicts(taskA, taskB) {
  const conflicts = [];
  const warnings = [];
  
  // Check if both tasks target the same element
  if (taskA.args?.elementId && taskB.args?.elementId && taskA.args.elementId === taskB.args.elementId) {
    conflicts.push({
      type: 'same_element',
      taskA: taskA.id,
      taskB: taskB.id,
      elementId: taskA.args.elementId,
      severity: 'high',
      message: `Both tasks target the same element: ${taskA.args.elementId}`
    });
  }
  
  // Check if one task navigates and another interacts
  if (
    (taskA.name === 'browser_navigate' && ['browser_click', 'browser_fill', 'browser_key'].includes(taskB.name)) ||
    (taskB.name === 'browser_navigate' && ['browser_click', 'browser_fill', 'browser_key'].includes(taskA.name))
  ) {
    warnings.push({
      type: 'navigate_interact',
      taskA: taskA.id,
      taskB: taskB.id,
      severity: 'medium',
      message: 'One task navigates while another interacts - risk of stale state'
    });
  }
  
  // Check if both tasks write to storage
  if (
    ['browser_storage_write', 'browser_init_script'].includes(taskA.name) &&
    ['browser_storage_write', 'browser_init_script'].includes(taskB.name)
  ) {
    conflicts.push({
      type: 'storage_conflict',
      taskA: taskA.id,
      taskB: taskB.id,
      severity: 'high',
      message: 'Both tasks write to storage - potential data race'
    });
  }
  
  return { conflicts, warnings };
}

/**
 * Multi-agent conflict detection (same page, multiple agents)
 * Returns: { hasConflict: boolean, conflictDetails: [] }
 */
function detectMultiAgentConflicts(taskList, agentIds) {
  const conflicts = [];
  
  // Group tasks by agent
  const tasksByAgent = {};
  for (const task of taskList) {
    const agentId = task.metadata?.agentId || 'unknown';
    if (!tasksByAgent[agentId]) {
      tasksByAgent[agentId] = [];
    }
    tasksByAgent[agentId].push(task);
  }
  
  // Detect conflicts between different agents
  const agentIdsArr = Object.keys(tasksByAgent);
  for (let i = 0; i < agentIdsArr.length; i++) {
    for (let j = i + 1; j < agentIdsArr.length; j++) {
      const agentA = agentIdsArr[i];
      const agentB = agentIdsArr[j];
      
      // Check if both agents are operating on the same page
      const tasksA = tasksByAgent[agentA];
      const tasksB = tasksByAgent[agentB];
      
      for (const taskA of tasksA) {
        for (const taskB of tasksB) {
          const result = detectConflicts(taskA, taskB);
          if (result.conflicts.length > 0) {
            conflicts.push({
              agentA,
              agentB,
              conflicts: result.conflicts,
              warnings: result.warnings
            });
          }
        }
      }
    }
  }
  
  return {
    hasConflict: conflicts.length > 0,
    conflictDetails: conflicts
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Scheduler Core
// ─────────────────────────────────────────────────────────────────────────────

class AIScheduler {
  constructor() {
    this.taskHistory = [];
    this.conflictLog = [];
    this.stats = {
      totalTasksAssessed: 0,
      totalConflictsDetected: 0,
      totalParallelized: 0
    };
  }
  
  /**
   * Assess and schedule a task
   * Returns: { complexity, queueStrategy, recommendations }
   */
  assessAndSchedule(task, currentQueueLength = 0) {
    const complexity = assessComplexity(task);
    const queueStrategy = determineQueueStrategy(task, currentQueueLength);
    
    this.stats.totalTasksAssessed++;
    this.taskHistory.push({
      taskId: task.id,
      timestamp: Date.now(),
      complexity,
      queueStrategy
    });
    
    return {
      complexity,
      queueStrategy,
      recommendations: {
        executeImmediately: queueStrategy.action === 'execute',
        estimatedDuration: complexity.estimatedDuration,
        riskLevel: this.assessRiskLevel(complexity.complexity)
      }
    };
  }
  
  /**
   * Assess risk level based on complexity
   */
  assessRiskLevel(complexity) {
    switch (complexity) {
      case 'simple': return 'low';
      case 'moderate': return 'medium';
      case 'complex': return 'high';
      case 'critical': return 'critical';
      default: return 'medium';
    }
  }
  
  /**
   * Get scheduling recommendations for a batch of tasks
   */
  getBatchRecommendations(taskList) {
    const parallelization = suggestParallelization(taskList);
    const multiAgentResult = detectMultiAgentConflicts(taskList);
    
    if (multiAgentResult.hasConflict) {
      this.stats.totalConflictsDetected++;
      this.conflictLog.push({
        timestamp: Date.now(),
        conflicts: multiAgentResult.conflictDetails
      });
    }
    
    return {
      parallelization,
      conflicts: multiAgentResult,
      recommendedOrder: this.recommendExecutionOrder(taskList),
      estimatedTotalTime: this.estimateTotalTime(taskList)
    };
  }
  
  /**
   * Recommend execution order for tasks
   */
  recommendExecutionOrder(taskList) {
    // Sort by complexity (simple first) and urgency
    return [...taskList].sort((a, b) => {
      const complexityA = assessComplexity(a).score;
      const complexityB = assessComplexity(b).score;
      return complexityA - complexityB;
    });
  }
  
  /**
   * Estimate total execution time for a batch of tasks
   */
  estimateTotalTime(taskList) {
    const totalTime = taskList.reduce((sum, task) => {
      return sum + assessComplexity(task).estimatedDuration;
    }, 0);
    
    return totalTime;
  }
  
  /**
   * Get scheduler stats
   */
  getStats() {
    return {
      ...this.stats,
      recentConflicts: this.conflictLog.slice(-5),
      recentAssessments: this.taskHistory.slice(-10)
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export {
  AIScheduler,
  assessComplexity,
  determineQueueStrategy,
  suggestParallelization,
  detectConflicts,
  detectMultiAgentConflicts,
  COMPLEXITY_RULES
};
