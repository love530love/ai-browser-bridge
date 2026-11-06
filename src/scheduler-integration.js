/**
 * Scheduler Integration Layer
 * 
 * Wraps the existing queue system with intelligent scheduling capabilities:
 * - Priority engine enhancement
 * - AI-assisted task assessment
 * - Cross-instance load balancing
 * - Conflict detection
 * 
 * This layer is backwards compatible with the existing queue system.
 */
import { randomUUID } from 'node:crypto';
import { PriorityQueue, calculatePriority, decomposeTask } from './priority-engine.js';
import { LoadBalancer } from './load-balancer.js';
import { AIScheduler, detectConflicts as detectTaskConflicts } from './ai-scheduler.js';

/**
 * Create an enhanced scheduler that wraps the existing queue
 */
function createScheduler(config = {}) {
  const priorityQueue = new PriorityQueue(config.maxQueueSize || 32);
  const loadBalancer = new LoadBalancer();
  const aiScheduler = new AIScheduler();
  
  let instanceMode = config.instanceMode || false;
  let currentInstanceId = config.currentInstanceId || 'default';
  
  /**
   * Enhanced enqueue with AI assessment and priority scoring
   */
  async function enqueue(task) {
    const taskId = task.id || randomUUID();
    const taskData = { ...task, id: taskId };
    
    // 1. AI assessment (if enabled)
    let assessment = null;
    if (config.aiAssessmentEnabled !== false) {
      assessment = aiScheduler.assessAndSchedule(taskData, priorityQueue.queue.length);
    }
    
    // 2. Decomposition is ADVISORY ONLY. Its sub-tasks are synthetic browser
    // commands (browser_page_info / browser_observe / the original write).
    // Enqueueing them would put commands nobody asked for into an executable
    // queue, and enqueueing the original twice would double a write. This
    // scheduler scores and advises; the service's own queue dispatches real
    // commands. Return the suggestion as data, never materialise it.
    let subTasks = [];
    if (config.taskDecompositionEnabled !== false) {
      const decomposed = decomposeTask(taskData);
      if (decomposed.canDecompose && decomposed.subTasks.length > 0) {
        subTasks = decomposed.subTasks;
      }
    }

    // 3. Enqueue the one task the caller actually submitted.
    const result = priorityQueue.enqueue(taskData);

    return {
      ...result,
      assessment,
      subTasks: subTasks.map(st => st.id),
      subTaskSuggestions: subTasks.map(st => ({ name: st.name, phase: st.metadata?.phase })),
      stats: priorityQueue.getStatus()
    };
  }
  
  /**
   * Dequeue next task (respects priority order)
   */
  function dequeue() {
    return priorityQueue.dequeue();
  }
  
  /**
   * Check for timed-out tasks
   */
  function cleanupTimeouts() {
    return priorityQueue.cleanupTimeouts();
  }
  
  /**
   * Get queue status
   */
  function getStatus() {
    return {
      queue: priorityQueue.getStatus(),
      ai: aiScheduler.getStats(),
      instances: instanceMode ? loadBalancer.getLoadStatus() : null
    };
  }
  
  /**
   * Route task to best instance (if multi-instance mode)
   */
  async function routeTask(task) {
    if (!instanceMode) {
      return { routed: false, reason: 'single_instance_mode' };
    }
    
    return loadBalancer.routeTask(task);
  }
  
  /**
   * Detect conflicts between tasks
   */
  function detectConflicts(taskA, taskB) {
    // AIScheduler has no detectConflicts method; the detector is a module-level
    // function. Calling it through the instance used to throw TypeError on the
    // first conflict check, which no queue-status smoke test ever exercised.
    return detectTaskConflicts(taskA, taskB);
  }
  
  /**
   * Get batch recommendations
   */
  function getBatchRecommendations(taskList) {
    return aiScheduler.getBatchRecommendations(taskList);
  }
  
  /**
   * Update instance configuration
   */
  function updateInstanceConfig(newConfig) {
    if (newConfig.instanceMode !== undefined) {
      instanceMode = newConfig.instanceMode;
    }
    if (newConfig.currentInstanceId !== undefined) {
      currentInstanceId = newConfig.currentInstanceId;
    }
  }
  
  return {
    enqueue,
    dequeue,
    cleanupTimeouts,
    getStatus,
    routeTask,
    detectConflicts,
    getBatchRecommendations,
    updateInstanceConfig,
    priorityQueue,
    loadBalancer,
    aiScheduler
  };
}

export { createScheduler };
